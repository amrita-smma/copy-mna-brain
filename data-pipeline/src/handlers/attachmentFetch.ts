import {
  streamMboxMessages,
  extractRawAttachmentParts,
} from '../mboxParser';
import {
  extractEmailList,
  stripAngleBrackets,
} from '@/lib/services/googleVaultService';
import { parseMessage, getHeader } from '../mboxParser';
import type { RawMessage } from '../mboxParser';
import { MboxFileRepository, EmailAttachmentRepository } from '../repositories';
import type { EmailAttachment } from '../repositories';
import type { DbClient, Tables } from '@/lib/repositories';
import { uploadFile } from '@/lib/s3';
import { openS3GunzipStream } from '../s3Stream';
import { flattenHeaders, synthesizeMessageId } from './vaultParse';
import type { ExtractedEmail } from './vaultParse';

export const ATTACHMENT_FETCH_TIMEOUT_SECONDS = 1800;
export const DEFAULT_LIMIT = 1000;
export const DEFAULT_BATCH_SIZE = 5000;

// Attachment bytes go into the mbox bucket under an `attachments/` prefix.
// Content-addressed: same bytes → same key across all emails.
const ATTACHMENT_BUCKET = process.env.AWS_S3_MBOX_BUCKET ?? 'mbox-archive';

const MIME_TO_EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

function attachmentS3Key(contentHash: string, mimeType: string): string {
  const ext = MIME_TO_EXT[mimeType] ?? 'bin';
  return `attachments/${contentHash}.${ext}`;
}

export interface AttachmentFetchPayload {
  limit?: number;
}

export interface AttachmentFetchResult {
  files_processed: number;
  files_failed: number;
  attachments_fetched: number;
  attachments_deduped: number;
  attachments_failed: number;
}

const log = (msg: string) => console.log(`[attachment-fetch] ${msg}`);

// Reproduce the same message_id resolution that vaultParse uses, so the
// lookup against email_attachments.message_id matches for every message
// including header-less (synthesized-id) ones.
function resolveRawMessageId(raw: RawMessage): string {
  const flat = flattenHeaders(raw.headers);
  const msgId = stripAngleBrackets(flat['message-id'] ?? undefined);
  if (msgId) return msgId;
  // No message-id header: synthesize the same way vaultParse does.
  const fromList = extractEmailList(flat['from'] ?? '');
  const parsed = parseMessage(raw);
  const email: ExtractedEmail = {
    message_id: null,
    from_email: fromList[0]?.address ?? null,
    from_display_name: fromList[0]?.displayName ?? null,
    to_emails: [],
    cc_emails: [],
    subject: flat['subject'] ?? null,
    body: parsed.body,
    sent_at: parsed.date,
    has_attachments: false,
    in_reply_to: null,
    references: null,
    gmail_thread_id: null,
    raw_headers: flat,
  };
  return synthesizeMessageId(email);
}

function decodePartBody(body: string, encoding: string): Buffer {
  const enc = (encoding || '').toLowerCase().trim();
  if (enc === 'base64') {
    return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  }
  if (enc === 'quoted-printable') {
    const collapsed = body.replace(/=\r?\n/g, '');
    const bytes: number[] = [];
    for (let i = 0; i < collapsed.length; i++) {
      const ch = collapsed[i];
      if (ch === '=' && /[0-9A-Fa-f]/.test(collapsed[i + 1] ?? '') && /[0-9A-Fa-f]/.test(collapsed[i + 2] ?? '')) {
        bytes.push(parseInt(collapsed.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(ch.charCodeAt(0) & 0xff);
      }
    }
    return Buffer.from(bytes);
  }
  return Buffer.from(body, 'utf-8');
}

export async function runAttachmentFetch(
  payload: AttachmentFetchPayload,
  deps: { db: DbClient; job: Tables<'jobs'> },
): Promise<AttachmentFetchResult> {
  const limit = Math.max(1, payload.limit ?? DEFAULT_LIMIT);
  const repo = new EmailAttachmentRepository(deps.db);
  const mboxRepo = new MboxFileRepository(deps.db);

  log(`starting job=${deps.job.id} limit=${limit}`);

  const result: AttachmentFetchResult = {
    files_processed: 0,
    files_failed: 0,
    attachments_fetched: 0,
    attachments_deduped: 0,
    attachments_failed: 0,
  };

  // 1. Load all needs_fetch rows.
  const targets = await repo.listNeedsFetch(limit);
  if (targets.length === 0) {
    log('nothing to fetch');
    return result;
  }

  // 2. Group by file_id — one mbox re-stream per file.
  const byFile = new Map<string, EmailAttachment[]>();
  for (const row of targets) {
    const arr = byFile.get(row.file_id) ?? [];
    arr.push(row);
    byFile.set(row.file_id, arr);
  }

  log(`targets=${targets.length} files=${byFile.size}`);

  for (const [fileId, rows] of byFile) {
    try {
      const mboxFile = await mboxRepo.findById(fileId);
      if (!mboxFile) {
        log(`file ${fileId} not found — marking rows failed`);
        for (const row of rows) {
          await repo.markFailed(row.id, 'mbox_file_not_found');
          result.attachments_failed++;
        }
        result.files_failed++;
        continue;
      }

      // Build lookup: message_id → [attachment rows for that message]
      const msgMap = new Map<string, EmailAttachment[]>();
      for (const row of rows) {
        const arr = msgMap.get(row.message_id) ?? [];
        arr.push(row);
        msgMap.set(row.message_id, arr);
      }

      // Cross-email dedup: if a content_hash is already uploaded, reuse it.
      const dedupedIds = new Set<string>();
      for (const row of rows) {
        if (dedupedIds.has(row.id)) continue;
        const existing = await repo.findUploadedByHash(row.content_hash);
        if (existing && existing.s3_key && existing.id !== row.id) {
          await repo.markFetched(row.id, {
            s3_bucket: existing.s3_bucket!,
            s3_key: existing.s3_key,
            size_bytes: existing.size_bytes ?? 0,
          });
          dedupedIds.add(row.id);
          result.attachments_deduped++;
        }
      }

      // Remove deduped rows from the message map.
      for (const [msgId, msgRows] of msgMap) {
        const remaining = msgRows.filter((r) => !dedupedIds.has(r.id));
        if (remaining.length === 0) msgMap.delete(msgId);
        else msgMap.set(msgId, remaining);
      }

      if (msgMap.size === 0) {
        result.files_processed++;
        continue;
      }

      // Re-stream the mbox: one pass, pull attachment bytes for qualifying messages.
      const gunzipStream = await openS3GunzipStream(mboxFile.s3_key, mboxFile.s3_bucket);
      const fetched = new Set<string>(); // attachment ids fetched this pass

      for await (const raw of streamMboxMessages(gunzipStream)) {
        const msgId = resolveRawMessageId(raw);
        const targetRows = msgMap.get(msgId);
        if (!targetRows || targetRows.length === 0) continue;

        const rawParts = extractRawAttachmentParts(raw.headers, raw.rawBody);

        for (const row of targetRows) {
          if (fetched.has(row.id)) continue;

          const part = rawParts.find((p) => p.content_hash === row.content_hash);
          if (!part) {
            log(`part not found for ${row.id} (hash=${row.content_hash.slice(0, 8)}) — will mark failed after stream`);
            continue;
          }

          try {
            const decoded = decodePartBody(part.body, part.encoding);
            const s3Key = attachmentS3Key(row.content_hash, row.mime_type ?? part.mime_type);
            await uploadFile(decoded, s3Key, row.mime_type ?? part.mime_type, ATTACHMENT_BUCKET);
            await repo.markFetched(row.id, {
              s3_bucket: ATTACHMENT_BUCKET,
              s3_key: s3Key,
              size_bytes: decoded.length,
            });
            fetched.add(row.id);
            result.attachments_fetched++;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            await repo.markFailed(row.id, `decode_upload_error: ${msg}`);
            fetched.add(row.id); // don't retry in this pass
            result.attachments_failed++;
          }
        }
      }

      // Any rows still not fetched or deduped couldn't be located in the mbox.
      for (const msgRows of msgMap.values()) {
        for (const row of msgRows) {
          if (!fetched.has(row.id)) {
            await repo.markFailed(row.id, 'part_not_found_in_mbox');
            result.attachments_failed++;
          }
        }
      }

      result.files_processed++;
      log(`file ${fileId} done: fetched=${result.attachments_fetched} deduped=${result.attachments_deduped} failed=${result.attachments_failed}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`file ${fileId} failed: ${msg}`);
      for (const row of rows) {
        try { await repo.markFailed(row.id, `file_error: ${msg}`); } catch { /* ignore */ }
        result.attachments_failed++;
      }
      result.files_failed++;
    }
  }

  log(`done: ${JSON.stringify(result)}`);
  return result;
}
