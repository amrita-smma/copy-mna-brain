import * as crypto from 'node:crypto';
import * as zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
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
  type RawMessage,
} from '../mboxParser';
import { MboxFileRepository, RawEmailRepository } from '../repositories';
import type {
  DbClient,
  Tables,
  TablesInsert,
} from '@/lib/repositories';

export const VAULT_PARSE_TIMEOUT_SECONDS = 1800; // 30 minutes
export const INSERT_BATCH_SIZE = 1000;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export interface VaultParsePayload {
  fileIds?: string[];
  limit?: number;
  force?: boolean;
}

export interface VaultParseResult {
  files_processed: number;
  files_failed: number;
  files_skipped: number;
  raw_emails_inserted: number;
  raw_emails_skipped_dupe: number;
  raw_emails_synthesized_id: number;
}

// Normalised email representation built from a RawMessage. Mirrors the fields
// that buildRawEmailRow needs so we don't depend on googleVaultService.ParsedEmail.
interface ExtractedEmail {
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
function flattenHeaders(headers: RawMessage['headers']): Record<string, string> {
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

/**
 * Open the gzipped MBOX from S3 and return an AsyncIterable of Buffers so
 * streamMboxMessages can consume it without buffering the whole file.
 */
async function openS3GunzipStream(
  s3Key: string,
  s3Bucket: string,
): Promise<AsyncIterable<Buffer>> {
  const region = process.env.AWS_REGION || 'ap-southeast-3';
  const endpoint = process.env.AWS_S3_ENDPOINT;
  const forcePathStyle = process.env.AWS_S3_FORCE_PATH_STYLE === 'true';

  const s3 = new S3Client({
    region,
    ...(endpoint ? { endpoint, forcePathStyle } : {}),
  });

  const response = await s3.send(
    new GetObjectCommand({ Bucket: s3Bucket, Key: s3Key }),
  );

  const body = response.Body as Readable;
  const gunzip = zlib.createGunzip();
  body.pipe(gunzip);
  return gunzip;
}

export async function runVaultParse(
  payload: VaultParsePayload,
  deps: { db: DbClient; job: Tables<'jobs'> },
): Promise<VaultParseResult> {
  const force = payload.force === true;
  const limit = Math.max(1, Math.min(MAX_LIMIT, payload.limit ?? DEFAULT_LIMIT));

  const mboxRepo = new MboxFileRepository(deps.db);
  const rawRepo = new RawEmailRepository(deps.db);

  // 1. Resolve the target file set.
  let targets: Tables<'mbox_files'>[] = [];
  if (payload.fileIds && payload.fileIds.length > 0) {
    for (const id of payload.fileIds) {
      const row = await mboxRepo.findById(id);
      if (row) targets.push(row);
    }
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
  };

  for (const target of targets) {
    const started = Date.now();
    let file = target;

    // 2. Claim (or skip if not in a retryable state). With force=true, bypass
    // the claim entirely and process whatever state the file is in.
    if (!force) {
      const claimed = await mboxRepo.markParsing(file.id, ['pending']);
      if (!claimed) {
        debug(`skip ${file.id}: not in retryable state`);
        result.files_skipped++;
        continue;
      }
      file = claimed;
    }

    try {
      // 3. Open S3 → gunzip stream; feed into mboxParser without buffering the
      // entire decompressed file. Peak memory ≈ largest single message.
      const gunzipStream = await openS3GunzipStream(file.s3_key, file.s3_bucket);

      // 4. Stream messages → extract fields → batch insert.
      let batch: TablesInsert<'raw_emails'>[] = [];
      let insertedHere = 0;
      let skippedHere = 0;
      let synthesizedHere = 0;

      const flushBatch = async (): Promise<void> => {
        if (batch.length === 0) return;
        const returned = await rawRepo.insertBatch(batch);
        insertedHere += returned.length;
        skippedHere += batch.length - returned.length;
        batch = [];
      };

      for await (const raw of streamMboxMessages(gunzipStream)) {
        const email = extractEmail(raw);
        const { row, synthesized } = buildRawEmailRow(file, email);
        if (synthesized) synthesizedHere++;
        batch.push(row);
        if (batch.length >= INSERT_BATCH_SIZE) await flushBatch();
      }
      await flushBatch();

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
