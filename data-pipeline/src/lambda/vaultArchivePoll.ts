/**
 * vault-archive-poll (no-S3 email cutover).
 *
 * Polls in-flight Vault exports. On COMPLETED it streams each ZIP, spools ONE
 * `.mbox` entry at a time to Lambda /tmp, and runs the single-pass processor
 * (privacy → LLM → CRM → Smart Files) directly against that file. No MBOX bytes are
 * ever written to S3. Each spooled file is unlinked in a finally.
 *
 * Resume: each entry is keyed by a stable source_key (export_id + zip object
 * name + entry path) in analytics.email_process_runs. On soft-stop (or when the
 * Lambda runs low on time) the matter is left OPEN and the export is set back
 * to 'exporting' so the next poll re-downloads the ZIP, cheaply skips already
 * completed/abandoned entries, and resumes the in-flight one from its cursor.
 * The matter is closed only once every entry is completed or terminally
 * abandoned.
 *
 * Connection/infra failures (Vault auth, poll API, ZIP download) bump
 * vault_exports.fail_count. At MAX_VAULT_POLL_FAIL_COUNT the export is marked
 * failed and the matter is closed so start can create a replacement within its
 * window retry budget. fail_count resets only after a ZIP download succeeds —
 * not on sticky COMPLETED alone.
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
/** Vault auth / poll / ZIP download failures before the export is abandoned. */
export const MAX_VAULT_POLL_FAIL_COUNT = 5;

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
  fail_count?: number;
}

interface ExportProcessOutcome {
  completed: number;
  abandoned: number;
  /** At least one entry still needs work (soft-stop / retry / out of time). */
  unfinished: boolean;
  /** ZIP download succeeded and fail_count was cleared. */
  downloadOk: boolean;
  failures: string[];
}

function queryRows<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  return ((res as { rows?: T[] } | null)?.rows ?? []) as T[];
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

async function resetPollFailCount(db: DbClient, id: string): Promise<void> {
  await db.execute(
    sql`UPDATE analytics.vault_exports
        SET fail_count = 0, updated_at = now()
        WHERE id = ${id}`,
  );
}

/**
 * Bump connection/infra fail budget. Under budget → back to exporting for
 * retry. At MAX → failed + best-effort matter close.
 */
async function recordConnectionFailure(
  db: DbClient,
  row: { id: string; matter_id: string },
  token: string | null,
  reason: string,
): Promise<'failed' | 'poll_error'> {
  const bumped = queryRows<{ fail_count: number; status: string }>(
    await db.execute(
      sql`UPDATE analytics.vault_exports
          SET fail_count = fail_count + 1,
              status = CASE
                WHEN fail_count + 1 >= ${MAX_VAULT_POLL_FAIL_COUNT} THEN 'failed'
                ELSE 'exporting'
              END,
              updated_at = now()
          WHERE id = ${row.id}
          RETURNING fail_count, status`,
    ),
  );
  const next = bumped[0]?.fail_count ?? MAX_VAULT_POLL_FAIL_COUNT;
  const status = bumped[0]?.status ?? 'exporting';

  if (status === 'failed' || next >= MAX_VAULT_POLL_FAIL_COUNT) {
    if (token) {
      try {
        await closeVaultMatter(token, row.matter_id);
      } catch (err) {
        console.error(
          `[vault-archive-poll] failed to close matter ${row.matter_id} after connection budget:`,
          err,
        );
      }
    }
    log(
      `connection budget exhausted (fail_count=${next}): ${reason} — status=failed`,
    );
    return 'failed';
  }

  log(
    `connection error (fail_count=${next}/${MAX_VAULT_POLL_FAIL_COUNT}): ${reason} — will retry`,
  );
  return 'poll_error';
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
 * matter close vs resume. ZIP download failures propagate to the caller so
 * they can hit the connection fail budget.
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
    downloadOk: false,
    failures: [],
  };

  // Only download/stream-open failures should propagate as connection errors.
  // Reset fail_count only after the ZIP is fully consumed (see below) so a
  // sticky COMPLETED + mid-body drop cannot wipe the budget every attempt.
  const zipStream = (await downloadExportFileStream(
    token,
    file,
  )) as unknown as Readable;
  outcome.downloadOk = true;

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

  // Body streamed without connection abort — clear prior auth/poll/download bumps.
  await resetPollFailCount(db, row.id);

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

    // 1. Atomically claim ONE exporting row (oldest first). A single UPDATE
    // with FOR UPDATE SKIP LOCKED holds the lock for the claim, so concurrent
    // invokes cannot double-bump fail_count on the same export.
    const { rows } = await db.execute<VaultExportsRow>(
      sql`UPDATE analytics.vault_exports AS ve
          SET status = 'processing', updated_at = now()
          FROM (
            SELECT id
            FROM analytics.vault_exports
            WHERE status = 'exporting'
            ORDER BY created_at
            LIMIT 1
            FOR UPDATE SKIP LOCKED
          ) AS pick
          WHERE ve.id = pick.id
          RETURNING ve.id, ve.matter_id, ve.export_id, ve.window_start,
                    ve.window_end, ve.mode, ve.custodian_emails, ve.fail_count`,
    );
    const row = rows[0];

    if (!row) {
      log('no in-flight exports');
      return { ok: true, action: 'idle' };
    }

    log(`processing export ${row.export_id} matter ${row.matter_id}`);

    let token: string;
    try {
      const creds = loadVaultCredentials();
      const subject =
        process.env.GOOGLE_VAULT_IMPERSONATE ?? 'crm.vault@starcapital.co.id';
      token = await getVaultAccessToken(creds, subject);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const action = await recordConnectionFailure(db, row, null, msg);
      return { ok: true, action };
    }

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
      const action = await recordConnectionFailure(db, row, token, msg);
      return { ok: true, action };
    }
    log(`poll result: ${status.status}`);

    if (status.status === 'IN_PROGRESS') {
      // Release claim so the next poll can pick this export again.
      await setStatus(db, row.id, 'exporting');
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

    // status.status === 'COMPLETED' — already claimed as processing above.
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
        // ZIP download / stream setup — connection budget, not soft-stop.
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`${file.objectName}: ${msg}`);
        console.error(
          `[vault-archive-poll] zip download failed: ${file.objectName}`,
          err,
        );
        const action = await recordConnectionFailure(db, row, token, msg);
        return { ok: true, action };
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
