import * as zlib from 'node:zlib';
import AdmZip from 'adm-zip';
import {
  loadVaultCredentials,
  getVaultAccessToken,
  createVaultMatter,
  createVaultExport,
  pollVaultExport,
  downloadExportFile,
  closeVaultMatter,
  VAULT_CUSTODIAN_EMAILS,
} from '@/lib/services/googleVaultService';
import { MboxFileRepository } from '../repositories';
import type { DbClient, Tables } from '@/lib/repositories';
import { uploadFile, S3_MBOX_BUCKET } from '@/lib/s3';

export const VAULT_ARCHIVE_TIMEOUT_SECONDS = 1800; // 30 minutes
export const VAULT_BACKFILL_FLOOR_DEFAULT = '2026-01';
export const VAULT_BACKFILL_FLOOR_DAILY_DEFAULT = '2026-01-01';

export type VaultArchiveMode = 'monthly' | 'daily' | 'live';

export interface YearMonth {
  year: number;
  month: number; // 1-12
}

export interface YearMonthDay {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

export function parseFloor(raw: string): YearMonth {
  const m = /^(\d{4})-(\d{1,2})$/.exec(raw.trim());
  if (!m) throw new Error(`VAULT_BACKFILL_FLOOR must be YYYY-MM, got "${raw}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < 2020 || year > 2100 || month < 1 || month > 12) {
    throw new Error(`VAULT_BACKFILL_FLOOR out of range: ${raw}`);
  }
  return { year, month };
}

export function currentMonthUTC(now: Date = new Date()): YearMonth {
  return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
}

export function previousMonth(ym: YearMonth): YearMonth {
  if (ym.month === 1) return { year: ym.year - 1, month: 12 };
  return { year: ym.year, month: ym.month - 1 };
}

export function ymLessThanOrEqual(a: YearMonth, b: YearMonth): boolean {
  return a.year < b.year || (a.year === b.year && a.month <= b.month);
}

export function ymStrictlyBefore(a: YearMonth, b: YearMonth): boolean {
  return a.year < b.year || (a.year === b.year && a.month < b.month);
}

/**
 * Every (year, month) from `floor` through `ceiling` inclusive, oldest first.
 * Returns [] if floor is strictly after ceiling.
 */
export function monthsBetween(floor: YearMonth, ceiling: YearMonth): YearMonth[] {
  const out: YearMonth[] = [];
  let cur = { ...floor };
  while (ymLessThanOrEqual(cur, ceiling)) {
    out.push({ ...cur });
    cur = cur.month === 12
      ? { year: cur.year + 1, month: 1 }
      : { year: cur.year, month: cur.month + 1 };
  }
  return out;
}

// ─── Day-level helpers (daily mode) ──────────────────────────────────────────

export function parseFloorDay(raw: string): YearMonthDay {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw.trim());
  if (!m) throw new Error(`daily backfill floor must be YYYY-MM-DD, got "${raw}"`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Round-trip through UTC to reject impossible dates (e.g. 2026-02-30).
  const d = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 2020 ||
    year > 2100 ||
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    throw new Error(`daily backfill floor out of range or invalid: ${raw}`);
  }
  return { year, month, day };
}

export function currentDayUTC(now: Date = new Date()): YearMonthDay {
  return {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate(),
  };
}

export function previousDay(ymd: YearMonthDay): YearMonthDay {
  const d = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day));
  d.setUTCDate(d.getUTCDate() - 1);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

export function ymdLessThanOrEqual(a: YearMonthDay, b: YearMonthDay): boolean {
  if (a.year !== b.year) return a.year < b.year;
  if (a.month !== b.month) return a.month < b.month;
  return a.day <= b.day;
}

/**
 * Every (year, month, day) from `floor` through `ceiling` inclusive, oldest
 * first. Returns [] if floor is strictly after ceiling.
 */
export function daysBetween(floor: YearMonthDay, ceiling: YearMonthDay): YearMonthDay[] {
  const out: YearMonthDay[] = [];
  const cur = new Date(Date.UTC(floor.year, floor.month - 1, floor.day));
  const end = new Date(Date.UTC(ceiling.year, ceiling.month - 1, ceiling.day));
  while (cur.getTime() <= end.getTime()) {
    out.push({
      year: cur.getUTCFullYear(),
      month: cur.getUTCMonth() + 1,
      day: cur.getUTCDate(),
    });
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

export interface VaultArchivePayload {
  year: number;
  month: number; // 1-12, no zero-padding
  day?: number; // 1-31, required when mode === 'daily'
  mode: VaultArchiveMode;
}

export interface VaultArchiveResult {
  files_uploaded: number;
  bytes_uploaded: number;
  bytes_uncompressed: number;
  window_start: string;
  window_end: string;
}

const POLL_INTERVAL_MS = 30_000;
const MAX_POLL_ATTEMPTS = 55; // 55 × 30s ≈ 27.5 minutes

const log = (msg: string) => console.log(`[vault-archive] ${msg}`);
const debug = (msg: string) => console.debug(`[vault-archive] ${msg}`);

/**
 * Compute the [startTime, endTime) window for a given (year, month) using
 * UTC calendar boundaries. End is exclusive — an email at the exact next-month
 * boundary belongs to the next archive.
 */
export function monthWindow(year: number, month: number): { start: Date; end: Date } {
  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  return { start, end };
}

/**
 * Compute the [startTime, endTime) window for a single (year, month, day) using
 * UTC calendar boundaries. End is exclusive — an email at the exact next-day
 * boundary belongs to the next archive. `day + 1` rolls over month/year ends
 * correctly via Date.UTC normalization.
 */
export function dayWindow(year: number, month: number, day: number): { start: Date; end: Date } {
  const start = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const end = new Date(Date.UTC(year, month - 1, day + 1, 0, 0, 0));
  return { start, end };
}

/**
 * Try to identify which custodian's mailbox a Vault MBOX entry belongs to by
 * matching its filename against the known custodian list. Vault names entries
 * with the account email prefix (e.g. "user@example.com-001.mbox"). Falls back
 * to 'unknown' so a malformed name doesn't break the whole run.
 *
 * Iteration order: longest custodian first, so an addition like
 * "g@starcapital.co.id" can't shadow "hendric.g@starcapital.co.id".
 */
export function inferCustodianFromEntry(
  entryName: string,
  custodians: string[] = VAULT_CUSTODIAN_EMAILS,
): string {
  const lower = entryName.toLowerCase();
  const sorted = [...custodians].sort((a, b) => b.length - a.length);
  for (const c of sorted) {
    if (lower.includes(c.toLowerCase())) return c;
  }
  return 'unknown';
}

export function buildS3Key(
  year: number,
  month: number,
  mode: VaultArchiveMode,
  custodian: string,
  exportId: string,
  basename: string,
  day?: number,
): string {
  const mm = String(month).padStart(2, '0');
  // Daily archives get an extra /DD/ segment so they don't collide with the
  // monthly object for the same month. Monthly keys are unchanged.
  const datePath = day != null ? `${mm}/${String(day).padStart(2, '0')}` : mm;
  return `vault/${year}/${datePath}/${mode}/${custodian}/${exportId}__${basename}.gz`;
}

export async function runVaultArchive(
  payload: VaultArchivePayload,
  deps: { db: DbClient; job: Tables<'jobs'> },
): Promise<VaultArchiveResult> {
  if (payload.mode !== 'monthly' && payload.mode !== 'daily') {
    // 'live' (sliding window inside the current period) is not implemented yet.
    throw new Error(`vault_archive mode '${payload.mode}' not implemented (PR #2)`);
  }

  const { year, month } = payload;
  const isDaily = payload.mode === 'daily';
  if (isDaily && (payload.day == null || !Number.isInteger(payload.day))) {
    throw new Error("vault_archive mode 'daily' requires an integer 'day'");
  }

  const { start, end } = isDaily
    ? dayWindow(year, month, payload.day as number)
    : monthWindow(year, month);
  const windowStartIso = start.toISOString();
  const windowEndIso = end.toISOString();

  log(`starting job=${deps.job.id} window=[${windowStartIso}, ${windowEndIso})`);

  const creds = loadVaultCredentials();
  const subject = process.env.GOOGLE_VAULT_IMPERSONATE ?? 'crm.vault@starcapital.co.id';
  log(`authenticating as ${creds.client_email} impersonating ${subject}`);
  const token = await getVaultAccessToken(creds, subject);

  let matterId: string;
  try {
    matterId = await createVaultMatter(token);
    log(`matter created: ${matterId}`);
  } catch (err) {
    console.error('[vault-archive] failed to create matter:', err);
    throw err;
  }

  let exportId: string;
  try {
    exportId = await createVaultExport(token, matterId, VAULT_CUSTODIAN_EMAILS, start, end);
    log(`export created: ${exportId}`);
  } catch (err) {
    console.error('[vault-archive] failed to create export:', err);
    await closeVaultMatter(token, matterId).catch(() => undefined);
    throw err;
  }

  let exportFiles: Awaited<ReturnType<typeof pollVaultExport>>['files'] = [];
  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    let status: Awaited<ReturnType<typeof pollVaultExport>>;
    try {
      status = await pollVaultExport(token, matterId, exportId);
    } catch (err) {
      console.error(`[vault-archive] poll attempt ${attempt + 1} failed:`, err);
      await closeVaultMatter(token, matterId).catch(() => undefined);
      throw err;
    }

    log(`poll ${attempt + 1}/${MAX_POLL_ATTEMPTS}: status=${status.status}`);

    if (status.status === 'COMPLETED') {
      exportFiles = status.files;
      log(`export completed with ${exportFiles.length} file(s)`);
      break;
    }
    if (status.status === 'FAILED') {
      await closeVaultMatter(token, matterId).catch(() => undefined);
      throw new Error(`Vault export ${exportId} failed`);
    }
    if (attempt < MAX_POLL_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  if (exportFiles.length === 0) {
    await closeVaultMatter(token, matterId).catch(() => undefined);
    throw new Error('Vault export did not complete within the timeout window');
  }

  const mboxRepo = new MboxFileRepository(deps.db);
  let filesUploaded = 0;
  let bytesUploaded = 0;
  let bytesUncompressed = 0;

  for (const file of exportFiles) {
    if (!file.objectName.endsWith('.zip')) {
      debug(`skipping non-zip file: ${file.objectName}`);
      continue;
    }

    log(`downloading ${file.objectName} (${file.size} bytes)`);
    const zipBuffer = await downloadExportFile(token, file);

    let zip: AdmZip;
    try {
      zip = new AdmZip(zipBuffer);
    } catch (err) {
      console.error(`[vault-archive] failed to open zip ${file.objectName}:`, err);
      throw err;
    }

    const mboxEntries = zip.getEntries().filter((e) => e.entryName.endsWith('.mbox'));
    log(`${file.objectName}: ${mboxEntries.length} MBOX entries`);

    for (const entry of mboxEntries) {
      const mboxBuffer = entry.getData();
      const uncompressedSize = mboxBuffer.length;
      const gzipped = zlib.gzipSync(mboxBuffer);
      const compressedSize = gzipped.length;

      const basename = entry.entryName.split('/').pop() ?? entry.entryName;
      const custodian = inferCustodianFromEntry(entry.entryName);
      const s3Key = buildS3Key(
        year,
        month,
        payload.mode,
        custodian,
        exportId,
        basename,
        isDaily ? (payload.day as number) : undefined,
      );

      await uploadFile(gzipped, s3Key, 'application/x-mbox', S3_MBOX_BUCKET, 'gzip');
      debug(`uploaded ${s3Key} (${compressedSize} bytes, ratio ${(uncompressedSize / compressedSize).toFixed(2)}x)`);

      await mboxRepo.insert({
        source: 'vault',
        s3_bucket: S3_MBOX_BUCKET,
        s3_key: s3Key,
        size_bytes: compressedSize,
        uncompressed_size_bytes: uncompressedSize,
        custodian_email: custodian,
        window_start: windowStartIso,
        window_end: windowEndIso,
        vault_matter_id: matterId,
        vault_export_id: exportId,
        mode: payload.mode,
        job_id: deps.job.id,
        parse_status: 'pending',
      });

      filesUploaded++;
      bytesUploaded += compressedSize;
      bytesUncompressed += uncompressedSize;
    }
  }

  await closeVaultMatter(token, matterId).catch((err) => {
    console.error('[vault-archive] failed to close matter (non-fatal):', err);
  });

  const result: VaultArchiveResult = {
    files_uploaded: filesUploaded,
    bytes_uploaded: bytesUploaded,
    bytes_uncompressed: bytesUncompressed,
    window_start: windowStartIso,
    window_end: windowEndIso,
  };
  log(`done: ${JSON.stringify(result)}`);
  return result;
}
