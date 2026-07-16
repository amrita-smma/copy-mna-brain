import { loadSecretsFromSsm } from '../secrets';
import { sql } from 'drizzle-orm';
import { createLambdaDb } from '../db';
import {
  loadVaultCredentials,
  getVaultAccessToken,
  createVaultMatter,
  createVaultExport,
} from '@/lib/services/googleVaultService';
import { UserWorkspaceRepository } from '@/lib/repositories';
import {
  currentDayUTC,
  previousDay,
  ymdLessThanOrEqual,
  daysBetween,
  dayWindow,
  parseFloorDay,
  VAULT_BACKFILL_FLOOR_DAILY_DEFAULT,
} from '../handlers/vaultArchive';

// Maximum concurrent Vault exports (quota cap for this service account).
const MAX_IN_FLIGHT = 3;
const log = (msg: string) => console.log(`[vault-archive-start] ${msg}`);

export interface VaultArchiveStartEvent {
  count?: number; // how many new exports to kick off (default 1, max 3)
}

export interface VaultArchiveStartResult {
  dispatched: Array<{
    window_start: string;
    window_end: string;
    matter_id: string;
    export_id: string;
  }>;
  skipped_in_flight: number;
}

export const handler = async (
  event: unknown,
  _ctx: unknown,
): Promise<{ ok: boolean; result: VaultArchiveStartResult }> => {
  const ev = (event ?? {}) as VaultArchiveStartEvent;
  const wantNew = Math.max(1, Math.min(MAX_IN_FLIGHT, Number(ev.count ?? 1)));

  await loadSecretsFromSsm();
  const { pgClient, db } = await createLambdaDb();

  try {
    // 0. Custodian mailboxes to watch — sourced from user_workspaces.is_email_synced,
    // not a hardcoded list, so syncing/un-syncing a mailbox in the app takes
    // effect on the next scheduled export. An empty result is surfaced loudly
    // (not a silent no-op) since this is a scheduled job hitting a real
    // external system.
    const custodianEmails = await new UserWorkspaceRepository(db).findSyncedCustodianEmails();
    if (custodianEmails.length === 0) {
      log('WARNING: no user_workspaces rows have is_email_synced=true — skipping, nothing to export');
      return { ok: true, result: { dispatched: [], skipped_in_flight: 0 } };
    }

    // 1. Count in-flight exports.
    const { rows: [{ count: inFlight }] } = await db.execute<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM analytics.vault_exports WHERE status = 'exporting'`,
    );
    const slots = MAX_IN_FLIGHT - Number(inFlight);
    if (slots <= 0) {
      log(`all ${MAX_IN_FLIGHT} slots in use, skipping`);
      return {
        ok: true,
        result: { dispatched: [], skipped_in_flight: Number(inFlight) },
      };
    }
    const toCreate = Math.min(wantNew, slots);

    // 2. Walk daily windows from floor to yesterday (last closed day).
    const floorDay = parseFloorDay(
      process.env.VAULT_BACKFILL_FLOOR_DAILY ?? VAULT_BACKFILL_FLOOR_DAILY_DEFAULT,
    );
    const ceiling = previousDay(currentDayUTC());
    if (!ymdLessThanOrEqual(floorDay, ceiling)) {
      log('floor is after ceiling — nothing to archive');
      return { ok: true, result: { dispatched: [], skipped_in_flight: Number(inFlight) } };
    }

    const candidates = daysBetween(floorDay, ceiling);

    // 3. Fetch all already-covered window_starts in one query, then find gaps.
    //    One query regardless of how many days have passed — O(1) vs O(n) per day.
    const floorIso = dayWindow(floorDay.year, floorDay.month, floorDay.day).start.toISOString();
    const ceilingIso = dayWindow(ceiling.year, ceiling.month, ceiling.day).end.toISOString();
    const MAX_RETRIES = 3;
    const { rows: coveredRows } = await db.execute<{ window_start: string; status: string }>(
      sql`SELECT window_start::text, status FROM analytics.vault_exports
          WHERE window_start >= ${floorIso}::timestamptz
            AND window_start <  ${ceilingIso}::timestamptz`,
    );
    const failureCounts = new Map<string, number>();
    const coveredStarts = new Set<string>();
    for (const r of coveredRows) {
      const ws = new Date(r.window_start).toISOString();
      if (r.status === 'failed') {
        failureCounts.set(ws, (failureCounts.get(ws) ?? 0) + 1);
      } else {
        coveredStarts.add(ws);
      }
    }
    // Windows that have hit the retry limit are also covered (give up).
    for (const [ws, count] of failureCounts) {
      if (count >= MAX_RETRIES) coveredStarts.add(ws);
    }

    const dispatched: VaultArchiveStartResult['dispatched'] = [];

    const creds = loadVaultCredentials();
    const subject = process.env.GOOGLE_VAULT_IMPERSONATE ?? 'crm.vault@starcapital.co.id';
    const token = await getVaultAccessToken(creds, subject);

    for (const ymd of candidates) {
      if (dispatched.length >= toCreate) break;

      const { start, end } = dayWindow(ymd.year, ymd.month, ymd.day);
      const windowStartIso = start.toISOString();
      const windowEndIso = end.toISOString();

      if (coveredStarts.has(windowStartIso)) {
        continue;
      }

      // Create matter + export.
      const matterId = await createVaultMatter(token);
      log(`matter created: ${matterId} for window [${windowStartIso}, ${windowEndIso})`);

      let exportId: string;
      try {
        exportId = await createVaultExport(token, matterId, custodianEmails, start, end);
        log(`export created: ${exportId}`);
      } catch (err) {
        console.error(`[vault-archive-start] failed to create export for ${matterId}:`, err);
        // Do NOT close the matter here — leave it for manual cleanup to avoid
        // destroying evidence. The row will not be inserted so poll won't pick
        // it up.
        throw err;
      }

      // Insert vault_exports row.
      await db.execute(
        sql`INSERT INTO analytics.vault_exports
              (matter_id, export_id, custodian_emails, window_start, window_end, mode, status)
            VALUES (
              ${matterId}, ${exportId},
              ARRAY[${sql.join(custodianEmails.map((e) => sql`${e}`), sql`, `)}]::text[],
              ${windowStartIso}::timestamptz,
              ${windowEndIso}::timestamptz,
              'daily',
              'exporting'
            )`,
      );

      dispatched.push({
        window_start: windowStartIso,
        window_end: windowEndIso,
        matter_id: matterId,
        export_id: exportId,
      });
    }

    log(`dispatched ${dispatched.length} new exports`);
    return { ok: true, result: { dispatched, skipped_in_flight: Number(inFlight) } };
  } finally {
    await pgClient.end();
  }
};
