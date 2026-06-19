import * as crypto from 'node:crypto';
import { openS3GunzipStream } from '../s3Stream';
import {
  extractEmailList,
  stripAngleBrackets,
  detectAttachments,
} from '@/lib/services/googleVaultService';
import {
  streamMboxMessages,
  parseMessage,
  getHeader,
  getAllHeaders,
  extractAttachments,
  type RawMessage,
} from '../mboxParser';
import { MboxFileRepository, RawEmailRepository, EmailAttachmentRepository } from '../repositories';
import type { EmailAttachmentInsert } from '../repositories';
import type {
  DbClient,
  Tables,
  TablesInsert,
} from '@/lib/repositories';

export const VAULT_PARSE_TIMEOUT_SECONDS = 1800; // 30 minutes
export const INSERT_BATCH_SIZE = 1000;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const PROGRESS_EVERY = 100; // log a progress line every N messages

export interface VaultParsePayload {
  fileIds?: string[];
  limit?: number;
  force?: boolean;
  // Backfill mode: re-stream already-parsed files to capture data added by
  // later pipeline stages (e.g. attachment metadata). Does NOT reset
  // parse_status — raw_email upserts are idempotent (ON CONFLICT DO NOTHING).
  reparse?: boolean;
}

export interface VaultParseResult {
  files_processed: number;
  files_failed: number;
  files_skipped: number;
  raw_emails_inserted: number;
  raw_emails_skipped_dupe: number;
  raw_emails_synthesized_id: number;
  attachments_captured: number;
}

// Normalised email representation built from a RawMessage. Mirrors the fields
// that buildRawEmailRow needs so we don't depend on googleVaultService.ParsedEmail.
// Exported for use by attachmentFetch (resolveRawMessageId).
export interface ExtractedEmail {
  message_id: string | null;
  from_email: string | null;
  from_display_name: string | null;
  to_emails: string[];
  cc_emails: string[];
  subject: string | null;
  body: string;
  sent_at: string | null;
  has_attachments: boolean;
  in_reply_to: string | null;
  references: string | null;
  gmail_thread_id: string | null;
  raw_headers: Record<string, string>;
}

const log = (msg: string) => console.log(`[vault-parse] ${msg}`);
const debug = (msg: string) => console.debug(`[vault-parse] ${msg}`);

/**
 * Convert the mboxParser Headers (multi-value) to a flat Record<string,string>
 * (first value wins) for compatibility with googleVaultService utilities that
 * operate on a flat header map.
 */
export function flattenHeaders(headers: RawMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, vals] of Object.entries(headers)) {
    if (vals.length > 0) out[key] = vals[0];
  }
  return out;
}

function extractEmail(raw: RawMessage): ExtractedEmail {
  const flat = flattenHeaders(raw.headers);
  const ccRaw = getAllHeaders(raw.headers, 'cc').join(', ');
  const fromList = extractEmailList(flat['from']);
  const toList = extractEmailList(flat['to']);
  const ccList = extractEmailList(ccRaw);
  const parsed = parseMessage(raw);
  return {
    message_id: stripAngleBrackets(flat['message-id'] ?? undefined),
    from_email: fromList[0]?.address ?? null,
    from_display_name: fromList[0]?.displayName ?? null,
    to_emails: toList.map((e) => e.address),
    cc_emails: ccList.map((e) => e.address),
    subject: flat['subject'] ?? null,
    body: parsed.body,
    sent_at: parsed.date,
    has_attachments: detectAttachments(flat, raw.rawBody),
    in_reply_to: stripAngleBrackets(flat['in-reply-to'] ?? undefined),
    references: flat['references']?.trim() || null,
    gmail_thread_id: flat['x-gm-thrid']?.trim() || null,
    raw_headers: flat,
  };
}

/**
 * Deterministic fallback ID for messages that arrived without an RFC 5322
 * Message-ID header. Stable across re-parses of the same content so the
 * partial-unique index still dedupes correctly.
 */
export function synthesizeMessageId(email: ExtractedEmail): string {
  const seed = [
    email.from_email ?? '',
    email.sent_at ?? '',
    email.subject ?? '',
    email.body.slice(0, 512),
  ].join('|');
  const hex = crypto.createHash('sha256').update(seed).digest('hex');
  return `sha256:${hex}`;
}

function buildRawEmailRow(
  file: Tables<'mbox_files'>,
  email: ExtractedEmail,
): { row: TablesInsert<'raw_emails'>; synthesized: boolean } {
  const synthesized = email.message_id == null;
  const message_id = email.message_id ?? synthesizeMessageId(email);
  return {
    synthesized,
    row: {
      file_id: file.id,
      custodian_email: file.custodian_email,
      message_id,
      from_address: email.from_email ?? null,
      from_display_name: email.from_display_name ?? null,
      to_addresses: email.to_emails.length > 0 ? email.to_emails : null,
      cc_addresses: email.cc_emails.length > 0 ? email.cc_emails : null,
      subject: email.subject ?? null,
      body_text: email.body,
      sent_at: email.sent_at ?? null,
      has_attachments: email.has_attachments,
      in_reply_to: email.in_reply_to ?? null,
      references: email.references ?? null,
      gmail_thread_id: email.gmail_thread_id ?? null,
      raw_headers: email.raw_headers,
    },
  };
}

export async function runVaultParse(
  payload: VaultParsePayload,
  deps: { db: DbClient; job: Tables<'jobs'> },
): Promise<VaultParseResult> {
  const force = payload.force === true;
  const reparse = payload.reparse === true;
  const limit = Math.max(1, Math.min(MAX_LIMIT, payload.limit ?? DEFAULT_LIMIT));

  const mboxRepo = new MboxFileRepository(deps.db);
  const rawRepo = new RawEmailRepository(deps.db);
  const attachmentRepo = new EmailAttachmentRepository(deps.db);

  // 1. Resolve the target file set.
  let targets: Tables<'mbox_files'>[] = [];
  if (payload.fileIds && payload.fileIds.length > 0) {
    for (const id of payload.fileIds) {
      const row = await mboxRepo.findById(id);
      if (row) targets.push(row);
    }
  } else if (reparse) {
    // reparse=true: re-stream all files regardless of parse_status, to backfill
    // data added by later pipeline stages (e.g. email_attachments). Raw email
    // upserts are idempotent; only new side-effects (attachment rows) land.
    targets = await mboxRepo.listAll(limit);
  } else {
    targets = await mboxRepo.listPending(limit, force);
  }

  log(
    `starting job=${deps.job.id} targets=${targets.length} force=${force} limit=${limit}`,
  );

  const result: VaultParseResult = {
    files_processed: 0,
    files_failed: 0,
    files_skipped: 0,
    raw_emails_inserted: 0,
    raw_emails_skipped_dupe: 0,
    raw_emails_synthesized_id: 0,
    attachments_captured: 0,
  };

  for (const target of targets) {
    const started = Date.now();
    let file = target;

    // 2. Claim (or skip if not in a retryable state). Bypass the claim when
    // force=true (retry failed files) or reparse=true (backfill all files).
    if (!force && !reparse) {
      const claimed = await mboxRepo.markParsing(file.id, ['pending']);
      if (!claimed) {
        debug(`skip ${file.id}: not in retryable state`);
        result.files_skipped++;
        continue;
      }
      file = claimed;
    }

    try {
      log(
        `parsing ${file.id} custodian=${file.custodian_email} s3=${file.s3_key} size=${file.size_bytes}`,
      );

      // 3. Open S3 → gunzip stream; feed into mboxParser without buffering the
      // entire decompressed file. Peak memory ≈ largest single message.
      const gunzipStream = await openS3GunzipStream(file.s3_key, file.s3_bucket);

      // 4. Stream messages → extract fields → batch insert.
      let batch: TablesInsert<'raw_emails'>[] = [];
      let attachmentBatch: EmailAttachmentInsert[] = [];
      let insertedHere = 0;
      let skippedHere = 0;
      let synthesizedHere = 0;
      let attachmentsHere = 0;
      let seenHere = 0;

      const flushBatch = async (): Promise<void> => {
        if (batch.length === 0) return;
        const returned = await rawRepo.insertBatch(batch);
        insertedHere += returned.length;
        skippedHere += batch.length - returned.length;
        batch = [];
      };

      const flushAttachments = async (): Promise<void> => {
        if (attachmentBatch.length === 0) return;
        // Dedupe within the batch by (message_id, content_hash) — two identical
        // parts in one message would otherwise trigger "ON CONFLICT DO UPDATE
        // cannot affect row a second time" in Postgres.
        const seen = new Set<string>();
        const deduped = attachmentBatch.filter((r) => {
          const key = `${r.message_id}:${r.content_hash}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const upserted = await attachmentRepo.upsertBatch(deduped);
        attachmentsHere += upserted.length;
        attachmentBatch = [];
      };

      for await (const raw of streamMboxMessages(gunzipStream)) {
        const email = extractEmail(raw);
        const { row, synthesized } = buildRawEmailRow(file, email);
        if (synthesized) synthesizedHere++;
        batch.push(row);
        seenHere++;

        // ⚠️ Use row.message_id (the resolved/synthesized id), NOT email.message_id
        // (which is null for header-less messages). This ensures the gate join
        // and P2 re-stream match work correctly for every message.
        if (email.has_attachments) {
          const metas = extractAttachments(raw.headers, raw.rawBody);
          for (const meta of metas) {
            attachmentBatch.push({
              file_id: file.id,
              message_id: row.message_id,
              part_index: meta.part_index,
              filename: meta.filename,
              mime_type: meta.mime_type,
              size_bytes: meta.size_bytes,
              content_hash: meta.content_hash,
              encoding: meta.encoding,
              state: 'metadata_only',
            });
          }
        }

        if (batch.length >= INSERT_BATCH_SIZE) await flushBatch();
        if (attachmentBatch.length >= INSERT_BATCH_SIZE) await flushAttachments();
        if (seenHere % PROGRESS_EVERY === 0) {
          log(
            `progress ${file.id} seen=${seenHere} inserted=${insertedHere} skipped=${skippedHere} elapsed=${Date.now() - started}ms`,
          );
        }
      }
      await flushBatch();
      await flushAttachments();

      // 5. Mark parsed.
      await mboxRepo.markParsed(file.id, insertedHere);
      const duration = Date.now() - started;
      log(
        `parsed ${file.id} custodian=${file.custodian_email} inserted=${insertedHere} skipped=${skippedHere} synthesized=${synthesizedHere} duration=${duration}ms`,
      );

      result.files_processed++;
      result.raw_emails_inserted += insertedHere;
      result.raw_emails_skipped_dupe += skippedHere;
      result.raw_emails_synthesized_id += synthesizedHere;
      result.attachments_captured += attachmentsHere;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[vault-parse] failed ${file.id}:`, err);
      try {
        await mboxRepo.markFailed(file.id, msg);
      } catch (persistErr) {
        console.error(
          `[vault-parse] also failed to persist failure for ${file.id}:`,
          persistErr,
        );
      }
      result.files_failed++;
    }
  }

  log(`done: ${JSON.stringify(result)}`);
  return result;
}
