/**
 * Reprocess `employer_related_companies` insights from the beginning of the deal.
 *
 * `employer_related_companies` (+ its evidence in
 * `analytics.employer_related_company_evidence`) are populated by `crm_ingest`
 * step [8], which reads `analytics.raw_email_enrichments.related_companies`.
 * That JSONB is only filled when the LLM enrichment ran with
 * `wantRelatedCompanies: true` — the default only since migration
 * `20260611000000_related_companies_analytics.sql`. Emails ingested before then
 * have `related_companies IS NULL` and were never scanned for related companies.
 *
 * This script backfills the insight across ALL historical emails in two phases,
 * both idempotent and batched:
 *
 *   Phase 1 — Enrich: for in-scope emails whose enrichment.related_companies is
 *     NULL (i.e. never scanned), re-run `crm_llm_submit` (Anthropic Messages
 *     Batches, ~half cost), then poll `crm_llm_fetch` until every batch ends.
 *     This writes `related_companies` onto raw_email_enrichments.
 *
 *   Phase 2 — Ingest: re-run `crm_ingest` (by rawEmailIds, in chunks) over every
 *     in-scope email. Step [8] upserts `employer_related_companies` + evidence.
 *     The unique constraints on both tables make re-runs safe.
 *
 * Every handler call is wrapped in `withJob`, so each unit shows up in the
 * `jobs` table with state transitions in `job_logs` (project convention:
 * long-running work is a job).
 *
 * Usage (from repo root):
 *   pnpm --filter data-pipeline reprocess-related-companies [flags]
 *
 * Flags:
 *   --since=YYYY-MM-DD    Only emails with sent_at >= this date. Default: all time.
 *   --dry-run            Print the plan (candidate + to-enrich counts) and exit.
 *   --no-enrich          Skip Phase 1 (LLM). Only re-ingest already-extracted data (free).
 *   --enrich-all         Phase 1 re-enriches every in-scope email, not just NULL ones (expensive).
 *   --enrich-chunk=N     Rows per crm_llm_submit call. Default 500 (max 1000).
 *   --ingest-chunk=N     Rows per crm_ingest call. Default 500.
 *   --poll-interval=SEC  Seconds between crm_llm_fetch polls. Default 30.
 *   --poll-timeout=MIN   Give up waiting for batches after this many minutes. Default 180.
 *
 * Env: same as the pipeline handlers — DB_* (or RDS_IAM_DB_AUTH), ANTHROPIC_API_KEY.
 * Loads .env.local then .env from the repo root, exactly like invoke-local.ts.
 */
import { config } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root is two levels up from data-pipeline/scripts/.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
config({ path: resolve(repoRoot, '.env.local') });
config({ path: resolve(repoRoot, '.env') });

interface Flags {
  since: string | null;
  dryRun: boolean;
  noEnrich: boolean;
  enrichAll: boolean;
  enrichChunk: number;
  ingestChunk: number;
  pollIntervalMs: number;
  pollTimeoutMs: number;
}

function parseFlags(argv: string[]): Flags {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (!hit) return undefined;
    const sep = hit.indexOf('=');
    return sep === -1 ? 'true' : hit.slice(sep + 1);
  };
  const num = (name: string, def: number, min: number, max: number): number => {
    const raw = get(name);
    if (raw === undefined) return def;
    const n = Number(raw);
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, Math.trunc(n)));
  };

  const since = get('since') ?? null;
  if (since && Number.isNaN(Date.parse(since))) {
    throw new Error(`--since must be a valid date (YYYY-MM-DD), got: ${since}`);
  }

  return {
    since,
    dryRun: get('dry-run') === 'true',
    noEnrich: get('no-enrich') === 'true',
    enrichAll: get('enrich-all') === 'true',
    enrichChunk: num('enrich-chunk', 500, 1, 1000), // crm_llm_submit MAX_LIMIT
    ingestChunk: num('ingest-chunk', 500, 1, 20000),
    pollIntervalMs: num('poll-interval', 30, 5, 600) * 1000,
    pollTimeoutMs: num('poll-timeout', 180, 1, 1440) * 60_000,
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (msg: string) => console.log(`[reprocess-rc] ${msg}`);

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  log(`flags: ${JSON.stringify(flags)}`);

  // Dynamic imports AFTER dotenv so module-level env reads see the values.
  const { and, asc, eq, gte, inArray, isNull, isNotNull, sql } = await import('drizzle-orm');
  const { rawEmails, rawEmailEnrichments } = await import('@/lib/db/schema');
  const { createLambdaDb } = await import('../src/db');
  const { withJob } = await import('../src/withJob');
  const { runCrmLlmSubmit } = await import('../src/handlers/crmLlmSubmit');
  const { runCrmLlmFetch } = await import('../src/handlers/crmLlmFetch');
  const { runCrmIngest } = await import('../src/handlers/crmIngest');
  const { LlmBatchRepository } = await import('../src/repositories');

  const { pgClient, db } = await createLambdaDb();
  try {
    // ---- Scope: every real business email since the beginning of the deal. ----
    // We include both 'ingested' (already in the CRM) AND 'pending' (parsed +
    // maybe enriched, but crm_ingest never ran). The 'pending' rows are the
    // reason employer_related_companies can be empty: step [8] only runs during
    // crm_ingest, so an email that stopped at enrichment never produced related
    // companies. Phase 2 runs crm_ingest for them, which both ingests them and
    // writes their related companies. 'filtered'/'failed' rows are excluded —
    // newsletters / auto-replies / personal are never CRM evidence.
    const sinceCond = flags.since ? gte(rawEmails.sent_at, flags.since) : undefined;
    const scopeCond = and(
      inArray(rawEmails.ingest_status, ['ingested', 'pending']),
      isNotNull(rawEmails.from_address),
      ...(sinceCond ? [sinceCond] : []),
    );

    const candidates = await db
      .select({ id: rawEmails.id })
      .from(rawEmails)
      .where(scopeCond)
      .orderBy(asc(rawEmails.sent_at));
    const candidateIds = candidates.map((r) => r.id);
    log(`candidates in scope: ${candidateIds.length}`);

    // Self-diagnosis: if nothing is in scope, show where the emails actually
    // are so it's obvious whether they're filtered, failed, or the table is
    // empty — rather than silently doing nothing.
    if (candidateIds.length === 0) {
      const breakdown = await db
        .select({
          ingest_status: rawEmails.ingest_status,
          llm_status: rawEmails.llm_status,
          n: sql<number>`count(*)::int`,
        })
        .from(rawEmails)
        .groupBy(rawEmails.ingest_status, rawEmails.llm_status);
      if (breakdown.length === 0) {
        log('no raw_emails exist at all — nothing has been parsed/ingested yet.');
      } else {
        log('nothing in scope. Current raw_emails state (ingest_status / llm_status → count):');
        for (const b of breakdown) log(`  ${b.ingest_status} / ${b.llm_status} → ${b.n}`);
        log(
          'Scope is ingest_status IN (ingested, pending). Rows sitting in ' +
            'filtered/failed are intentionally skipped. If you expected rows ' +
            'here, check --since and the states above.',
        );
      }
      return;
    }

    // ---- Rows that still need related-company extraction. ----
    // LEFT-ish: a row with no enrichment row, or enrichment.related_companies
    // NULL, has never been scanned. --enrich-all re-scans everyone.
    let toEnrichIds: string[] = [];
    if (!flags.noEnrich) {
      if (flags.enrichAll) {
        toEnrichIds = [...candidateIds];
      } else {
        const missing = await db
          .select({ id: rawEmails.id })
          .from(rawEmails)
          .leftJoin(
            rawEmailEnrichments,
            eq(rawEmailEnrichments.raw_email_id, rawEmails.id),
          )
          .where(and(scopeCond, isNull(rawEmailEnrichments.related_companies)))
          .orderBy(asc(rawEmails.sent_at));
        toEnrichIds = missing.map((r) => r.id);
      }
    }
    log(`rows needing enrichment: ${flags.noEnrich ? 'skipped (--no-enrich)' : toEnrichIds.length}`);

    if (flags.dryRun) {
      log('dry-run: no changes made. Exiting.');
      return;
    }

    // ================= Phase 1 — Enrich (LLM, batch mode) =================
    if (!flags.noEnrich && toEnrichIds.length > 0) {
      log(`Phase 1: submitting ${toEnrichIds.length} rows in chunks of ${flags.enrichChunk}`);
      let submitted = 0;
      for (const [i, ids] of chunk(toEnrichIds, flags.enrichChunk).entries()) {
        const res = await withJob(db, 'crm_llm_submit', { rawEmailIds: ids, mode: 'batch' }, (deps) =>
          runCrmLlmSubmit({ rawEmailIds: ids, mode: 'batch' }, deps),
        );
        submitted += res.requests_submitted;
        log(
          `  submit chunk ${i + 1}: extracted=${res.rows_extracted} needs_llm=${res.rows_needs_llm} ` +
            `no_llm=${res.rows_no_llm} filtered=${res.rows_filtered} batches=${res.batches_submitted} errors=${res.errors}`,
        );
      }
      log(`Phase 1: submitted ${submitted} LLM requests. Polling for completion…`);

      // Poll crm_llm_fetch until no batch is still in_progress (or timeout).
      const batchRepo = new LlmBatchRepository(db);
      const deadline = Date.now() + flags.pollTimeoutMs;
      for (;;) {
        const res = await withJob(db, 'crm_llm_fetch', {}, (deps) => runCrmLlmFetch({}, deps));
        log(
          `  fetch: polled=${res.batches_polled} fetched=${res.batches_fetched} ` +
            `failed=${res.batches_failed} enriched=${res.rows_enriched} filtered=${res.rows_filtered}`,
        );
        const inFlight = await batchRepo.listInProgress();
        if (inFlight.length === 0) {
          log('Phase 1: all batches ended.');
          break;
        }
        if (Date.now() >= deadline) {
          log(
            `Phase 1: WARNING — timed out with ${inFlight.length} batch(es) still in_progress. ` +
              `Re-run later to finish, then re-run this script with --no-enrich to ingest.`,
          );
          break;
        }
        log(`  ${inFlight.length} batch(es) still in_progress; sleeping ${flags.pollIntervalMs / 1000}s`);
        await sleep(flags.pollIntervalMs);
      }
    }

    // ================= Phase 2 — Ingest (populate related companies) =================
    // Re-query scope: Phase 1 may have flipped newsletters / personal rows to
    // ingest_status='filtered' (via shouldSkip / the LLM's is_personal flag), so
    // the pre-Phase-1 candidateIds can be stale. Ingesting a now-filtered row
    // would resurrect it as CRM evidence — re-select to drop them.
    const ingestTargets = await db
      .select({ id: rawEmails.id })
      .from(rawEmails)
      .where(scopeCond)
      .orderBy(asc(rawEmails.sent_at));
    const ingestIds = ingestTargets.map((r) => r.id);
    if (ingestIds.length === 0) {
      log('Phase 2: nothing in scope to ingest (all rows filtered during Phase 1?).');
      return;
    }
    log(`Phase 2: re-ingesting ${ingestIds.length} rows in chunks of ${flags.ingestChunk}`);
    let evidence = 0;
    for (const [i, ids] of chunk(ingestIds, flags.ingestChunk).entries()) {
      const res = await withJob(db, 'crm_ingest', { rawEmailIds: ids }, (deps) =>
        runCrmIngest({ rawEmailIds: ids }, deps),
      );
      evidence += res.related_companies_evidence_inserted;
      log(
        `  ingest chunk ${i + 1}: rows=${res.rows_ingested} ` +
          `related_company_evidence=${res.related_companies_evidence_inserted}`,
      );
    }
    log(`Done. Total related-company evidence rows inserted/refreshed: ${evidence}`);
  } finally {
    await pgClient.end();
  }
}

main().catch((err) => {
  console.error('[reprocess-rc] failed:', err);
  process.exit(1);
});
