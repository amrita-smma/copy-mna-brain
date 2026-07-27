/**
 * vault-archive-poll (no-S3 email cutover).
 *
 * Polls in-flight Vault exports. On COMPLETED it streams each ZIP, spools ONE
 * `.mbox` entry at a time to Lambda /tmp, and runs the single-pass processor
 * (privacy → LLM → CRM → AFD) directly against that file. No MBOX bytes are
 * ever written to S3. Each spooled file is unlinked in a finally.
 *
 * Resume: each entry is keyed by a stable source_key (export_id + zip object
 * name + entry path) in analytics.email_process_runs. On soft-stop (or when the
 * Lambda runs low on time) the matter is left OPEN and the export is set back
 * to 'exporting' so the next poll re-downloads the ZIP, cheaply skips already
 * completed/abandoned entries, and resumes the in-flight one from its cursor.
 * The matter is closed only once every entry is completed or terminally
 * abandoned.
 */

import { loadSecretsFromSsm } from '../secrets';
import { sql } from 'drizzle-orm';
import { createLambdaDb } from '../db';
import { createWriteStream, createReadStream } from 'node:fs';
import { unlink, mkdir } from 'node:fs/promises';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import * as unzipper from 'unzipper';
import {
  loadVaultCredentials,
  getVaultAccessToken,
  pollVaultExport,
  downloadExportFileStream,
  closeVaultMatter,
  type VaultExportFile,
} from '@/lib/services/googleVaultService';
import { inferCustodianFromEntry } from '../handlers/vaultArchive';
import {
  processMboxSource,
  getSourceRunState,
  isSourceTerminal,
  SOFT_STOP_MS,
} from '../handlers/emailProcess';
import { parseMessage, streamMboxMessages } from '../mboxParser';
import type { DbClient } from '@/lib/repositories';

const log = (msg: string) => console.log(`[vault-archive-poll] ${msg}`);

/** Time to reserve after a soft-stop for matter/db teardown before timeout. */
const TEARDOWN_RESERVE_MS = 90_000;
/** Don't spool a new entry without enough time for a clean soft-stop slice. */
const MIN_ENTRY_REMAINING_MS = 150_000;
/** Safely exceeds the 10-minute Lambda timeout plus teardown reserve. */
const STALE_PROCESSING_INTERVAL = '15 minutes';

interface VaultExportsRow extends Record<string, unknown> {
  id: string;
  matter_id: string;
  export_id: string;
  window_start: string;
  window_end: string;
  mode: string;
  // Snapshot of the custodian list resolved by vault-archive-start at creation
  // time — matched against exactly what was requested for this export.
  custodian_emails: string[];
}

interface ExportProcessOutcome {
  completed: number;
  abandoned: number;
  /** At least one entry still needs work (soft-stop / retry / out of time). */
  unfinished: boolean;
  failures: string[];
}

async function setStatus(
  db: DbClient,
  id: string,
  status: string,
): Promise<void> {
  await db.execute(
    sql`UPDATE analytics.vault_exports
        SET status = ${status}, updated_at = now()
        WHERE id = ${id}`,
  );
}

async function claimForProcessing(db: DbClient, id: string): Promise<boolean> {
  const res = await db.execute(
    sql`UPDATE analytics.vault_exports
        SET status = 'processing', updated_at = now()
        WHERE id = ${id}
          AND status = 'exporting'
        RETURNING id`,
  );
  const rows = Array.isArray(res)
    ? res
    : ((res as { rows?: unknown[] }).rows ?? []);
  return rows.length > 0;
}

async function reclaimStaleProcessing(db: DbClient): Promise<void> {
  await db.execute(
    sql`UPDATE analytics.vault_exports
        SET status = 'exporting', updated_at = now()
        WHERE status = 'processing'
          AND updated_at < now() - ${STALE_PROCESSING_INTERVAL}::interval`,
  );
}

function softStopBudget(remainingMs: number): number {
  if (!Number.isFinite(remainingMs)) return SOFT_STOP_MS;
  return Math.max(
    30_000,
    Math.min(SOFT_STOP_MS, remainingMs - TEARDOWN_RESERVE_MS),
  );
}

/**
 * Resolve the owning mailbox from message headers when Vault omits the
 * custodian address from the ZIP entry path. The mailbox owner should appear
 * on nearly every message, so require a unique highest count; ambiguity is
 * safer to retry/abandon than to write CRM facts into the wrong workspace.
 */
export async function inferCustodianFromMbox(
  openStream: () => Readable,
  custodians: string[],
  maxMessages = 200,
): Promise<string> {
  if (custodians.length === 1) return custodians[0]!;

  const canonical = new Map(
    custodians.map((email) => [email.toLowerCase(), email]),
  );
  const counts = new Map(custodians.map((email) => [email.toLowerCase(), 0]));
  let seen = 0;

  for await (const raw of streamMboxMessages(openStream())) {
    const parsed = parseMessage(raw);
    const participants = [
      parsed.sender?.email,
      ...parsed.recipients.map((recipient) => recipient.email),
      ...parsed.cc.map((recipient) => recipient.email),
    ];
    for (const email of new Set(participants.filter(Boolean).map((email) => email!.toLowerCase()))) {
      if (counts.has(email)) counts.set(email, counts.get(email)! + 1);
    }
    seen++;
    if (seen >= maxMessages) break;
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked[0] || ranked[0][1] === 0 || ranked[0][1] === ranked[1]?.[1]) {
    return 'unknown';
  }
  return canonical.get(ranked[0][0]) ?? 'unknown';
}

/**
 * Stream a single Vault ZIP, spooling each `.mbox` entry to /tmp and running
 * the processor against it. Returns per-entry outcome for the caller to decide
 * matter close vs resume.
 */
async function processExportZip(opts: {
  token: string;
  file: VaultExportFile;
  row: VaultExportsRow;
  db: DbClient;
  tmpDir: string;
  remainingMs: () => number;
}): Promise<ExportProcessOutcome> {
  const { token, file, row, db, tmpDir, remainingMs } = opts;
  const outcome: ExportProcessOutcome = {
    completed: 0,
    abandoned: 0,
    unfinished: false,
    failures: [],
  };

  const zipStream = (await downloadExportFileStream(
    token,
    file,
  )) as unknown as Readable;
  const parser = zipStream.pipe(unzipper.Parse({ forceStream: true }));

  try {
    for await (const entry of parser) {
      const entryPath: string = entry.path;
      if (entry.type === 'Directory' || !entryPath.endsWith('.mbox')) {
        await entry.autodrain().promise();
        continue;
      }

      const sourceKey = `${row.export_id}::${file.objectName}::${entryPath}`;

      // Cheap terminal skip so re-downloaded ZIPs don't re-spool finished work.
      const state = await getSourceRunState(db, sourceKey);
      if (isSourceTerminal(state)) {
        if (state!.status === 'completed') outcome.completed++;
        else outcome.abandoned++;
        await entry.autodrain().promise();
        continue;
      }

      // Not enough time to safely spool + soft-stop + tear down: defer the rest.
      if (remainingMs() < MIN_ENTRY_REMAINING_MS) {
        outcome.unfinished = true;
        await entry.autodrain().promise();
        break;
      }

      let custodian = inferCustodianFromEntry(
        `${file.objectName}/${entryPath}`,
        row.custodian_emails,
      );
      const tmpPath = join(tmpDir, `${randomUUID()}.mbox`);

      try {
        await streamPipeline(entry as unknown as Readable, createWriteStream(tmpPath));
        if (custodian === 'unknown') {
          custodian = await inferCustodianFromMbox(
            () => createReadStream(tmpPath),
            row.custodian_emails,
          );
        }

        const result = await processMboxSource(
          {
            sourceKey,
            custodianEmail: custodian,
            exportId: row.export_id,
            openStream: () => createReadStream(tmpPath),
          },
          { softStopMs: softStopBudget(remainingMs()) },
          { db },
        );

        if (result.status === 'completed') {
          outcome.completed++;
        } else if (result.status === 'abandoned') {
          outcome.abandoned++;
          outcome.failures.push(`${entryPath}: abandoned (budget exhausted)`);
        } else if (result.status === 'in_progress') {
          // Soft-stopped mid-entry — stop the pass; next poll resumes cursor.
          outcome.unfinished = true;
          break;
        } else {
          // 'failed' (retryable) — keep matter open, let siblings progress.
          outcome.unfinished = true;
          outcome.failures.push(`${entryPath}: failed (will retry)`);
        }
      } catch (err) {
        // Only infra errors (e.g. spool / ensureRun) reach here; retry later.
        outcome.unfinished = true;
        const msg = err instanceof Error ? err.message : String(err);
        outcome.failures.push(`${entryPath}: ${msg}`);
        console.error(
          `[vault-archive-poll] entry errored (will retry): ${entryPath}`,
          err,
        );
      } finally {
        await unlink(tmpPath).catch(() => undefined);
      }
    }
  } finally {
    // Ensure the download socket is released even when we break early.
    zipStream.destroy();
  }

  log(
    `${file.objectName}: completed=${outcome.completed} abandoned=${outcome.abandoned} unfinished=${outcome.unfinished}`,
  );
  return outcome;
}

export const handler = async (
  _event: unknown,
  context: { getRemainingTimeInMillis?: () => number },
): Promise<{ ok: boolean; action: string }> => {
  await loadSecretsFromSsm();
  const { pgClient, db: rawDb } = await createLambdaDb();
  const db = rawDb as unknown as DbClient;

  const remainingMs = (): number =>
    typeof context?.getRemainingTimeInMillis === 'function'
      ? context.getRemainingTimeInMillis()
      : Number.POSITIVE_INFINITY;

  const tmpDir = join(tmpdir(), 'vault-mbox');

  try {
    await mkdir(tmpDir, { recursive: true }).catch(() => undefined);

    // A hard Lambda timeout cannot execute the normal requeue path. Reclaim
    // claims older than the maximum invocation window before selecting work.
    await reclaimStaleProcessing(db);

    // 1. Pick ONE row to process (oldest first).
    const { rows } = await db.execute<VaultExportsRow>(
      sql`SELECT id, matter_id, export_id, window_start, window_end, mode, custodian_emails
          FROM analytics.vault_exports
          WHERE status = 'exporting'
          ORDER BY created_at
          LIMIT 1`,
    );
    const row = rows[0];

    if (!row) {
      log('no in-flight exports');
      return { ok: true, action: 'idle' };
    }

    log(`processing export ${row.export_id} matter ${row.matter_id}`);

    const creds = loadVaultCredentials();
    const subject =
      process.env.GOOGLE_VAULT_IMPERSONATE ?? 'crm.vault@starcapital.co.id';
    const token = await getVaultAccessToken(creds, subject);

    // 2. Poll the export status exactly once.
    let status: Awaited<ReturnType<typeof pollVaultExport>>;
    try {
      status = await pollVaultExport(token, row.matter_id, row.export_id);
    } catch (err) {
      // Matter was closed before we could poll — treat as terminal failure.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('FAILED_PRECONDITION') || msg.includes('state OPEN')) {
        await setStatus(db, row.id, 'failed');
        log(`matter already closed, cannot poll — status=failed`);
        return { ok: true, action: 'failed' };
      }
      throw err;
    }
    log(`poll result: ${status.status}`);

    if (status.status === 'IN_PROGRESS') {
      return { ok: true, action: 'waiting' };
    }

    if (status.status === 'FAILED') {
      try {
        await closeVaultMatter(token, row.matter_id);
      } catch (err) {
        console.error(
          `[vault-archive-poll] failed to close matter ${row.matter_id}:`,
          err,
        );
      }
      await setStatus(db, row.id, 'failed');
      log(`export FAILED — matter closed, status=failed`);
      return { ok: true, action: 'failed' };
    }

    // status.status === 'COMPLETED'
    const claimed = await claimForProcessing(db, row.id);
    if (!claimed) {
      log(`export ${row.export_id} was already claimed by another invocation`);
      return { ok: true, action: 'claimed_elsewhere' };
    }

    let completed = 0;
    let abandoned = 0;
    let unfinished = false;
    const failures: string[] = [];

    for (const file of status.files) {
      if (!file.objectName.endsWith('.zip')) continue;
      if (remainingMs() < MIN_ENTRY_REMAINING_MS) {
        unfinished = true;
        break;
      }
      log(`streaming ${file.objectName}`);
      try {
        const zipOutcome = await processExportZip({
          token,
          file,
          row,
          db,
          tmpDir,
          remainingMs,
        });
        completed += zipOutcome.completed;
        abandoned += zipOutcome.abandoned;
        unfinished = unfinished || zipOutcome.unfinished;
        for (const f of zipOutcome.failures) {
          failures.push(`${file.objectName}::${f}`);
        }
        if (zipOutcome.unfinished) break;
      } catch (err) {
        unfinished = true;
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${file.objectName}: ${msg}`);
        console.error(
          `[vault-archive-poll] zip failed (will retry): ${file.objectName}`,
          err,
        );
        break;
      }
    }

    // Still work to do → keep matter OPEN and requeue for the next poll.
    if (unfinished) {
      await setStatus(db, row.id, 'exporting');
      log(
        `resuming later: completed=${completed} abandoned=${abandoned} — ${failures.join('; ') || 'soft-stop / time budget'}`,
      );
      return { ok: true, action: 'resuming' };
    }

    // Terminal — every entry completed or abandoned. Always close the matter.
    try {
      await closeVaultMatter(token, row.matter_id);
    } catch (err) {
      console.error(
        `[vault-archive-poll] failed to close matter after archive (non-fatal):`,
        err,
      );
    }

    if (completed === 0 && abandoned > 0) {
      await setStatus(db, row.id, 'failed');
      log(`all entries abandoned (${abandoned}): ${failures.join('; ')}`);
      return { ok: true, action: 'failed' };
    }

    if (abandoned > 0) {
      await setStatus(db, row.id, 'archived_partial');
      log(
        `partial: completed=${completed} abandoned=${abandoned} — ${failures.join('; ')}`,
      );
      return { ok: true, action: 'archived_partial' };
    }

    await setStatus(db, row.id, 'archived');
    log(`archived ${completed} entr(y|ies), status=archived`);
    return { ok: true, action: 'archived' };
  } finally {
    await pgClient.end();
  }
};
