import { EmailAttachmentRepository } from '../repositories';
import type { DbClient, Tables } from '@/lib/repositories';
import { downloadFile } from '@/lib/s3';

export const ATTACHMENT_UPLOAD_TIMEOUT_SECONDS = 1800;
export const DEFAULT_LIMIT = 200;

// Internal API base URL — must be reachable from the Lambda execution environment.
// Locally: http://localhost:3000. Production: set INTERNAL_API_URL env var.
function internalApiUrl(): string {
  return process.env.INTERNAL_API_URL ?? 'http://localhost:3000';
}

// Session-mode routes accept X-Api-Secret for server-to-server calls.
// See src/proxy.ts — classifyApiRoute('/api/ai-file-dump') → 'session'.
function adminSecret(): string {
  return process.env.ADMIN_SECRET ?? '';
}

// Sanitise a filename for use in S3 keys and AFD display.
function sanitiseFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._\- ]/g, '_').trim() || 'attachment';
}

// Map pipeline triage doc_type to AFD file_type_override.
// Only mom needs explicit mapping; shopping_list / market_study are new AFD types.
// All other deal docs: no override — let AFD's own LLM classify.
const DOC_TYPE_TO_AFD_OVERRIDE: Record<string, string> = {
  mom: 'mom',
  shopping_list: 'shopping_list',
  market_study: 'market_study',
};

export interface AttachmentUploadPayload {
  limit?: number;
}

export interface AttachmentUploadResult {
  evaluated: number;
  uploaded: number;
  failed: number;
}

const log = (msg: string) => console.log(`[attachment-upload] ${msg}`);

async function getPresignedUploadUrl(
  fileName: string,
  contentType: string,
): Promise<{ uploadUrl: string; key: string }> {
  const params = new URLSearchParams({ fileName, contentType });
  const res = await fetch(
    `${internalApiUrl()}/api/ai-file-dump/upload-url?${params}`,
    { headers: { 'x-api-secret': adminSecret() } },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`upload-url failed (${res.status}): ${text}`);
  }
  const { data } = await res.json() as { data: { uploadUrl: string; key: string } };
  return data;
}

async function putToS3(uploadUrl: string, bytes: Buffer, contentType: string): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    body: bytes as unknown as BodyInit,
    headers: { 'Content-Type': contentType },
  });
  if (!res.ok) {
    throw new Error(`S3 PUT failed (${res.status})`);
  }
}

async function notifyAfd(opts: {
  key: string;
  fileName: string;
  contentType: string;
  fileTypeOverride?: string;
  originEmail: boolean;
  bankerSource?: string | null;
  enteredBy?: string | null;
}): Promise<void> {
  const body: Record<string, unknown> = {
    key: opts.key,
    fileName: opts.fileName,
    contentType: opts.contentType,
    origin_email: opts.originEmail,
  };
  if (opts.fileTypeOverride) {
    body.file_type_override = opts.fileTypeOverride;
  }
  if (opts.bankerSource) {
    body.banker_source = opts.bankerSource;
  }
  if (opts.enteredBy) {
    body.entered_by = opts.enteredBy;
  }

  const res = await fetch(`${internalApiUrl()}/api/ai-file-dump`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-secret': adminSecret(),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AFD notify failed (${res.status}): ${text}`);
  }
}

function mimeTypeToExtension(mimeType: string): string {
  const map: Record<string, string> = {
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/msword': 'doc',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  };
  return map[mimeType] ?? 'bin';
}

export async function runAttachmentUpload(
  payload: AttachmentUploadPayload,
  deps: { db: DbClient; job: Tables<'jobs'> },
): Promise<AttachmentUploadResult> {
  const limit = Math.max(1, payload.limit ?? DEFAULT_LIMIT);
  const repo = new EmailAttachmentRepository(deps.db);

  log(`starting job=${deps.job.id} limit=${limit} api=${internalApiUrl()}`);

  const result: AttachmentUploadResult = { evaluated: 0, uploaded: 0, failed: 0 };

  const groups = await repo.listDistinctNeedsExtractHashes(limit);
  if (groups.length === 0) {
    log('nothing to upload');
    return result;
  }

  log(`distinct docs to upload: ${groups.length}`);

  for (const group of groups) {
    result.evaluated++;

    try {
      // Cross-run dedupe: if an identical attachment hash was already pushed to
      // AFD in a previous batch, reuse that AFD key instead of creating another
      // file row. Grouping alone only dedupes rows selected in the current run.
      const existing = await repo.findDoneByHash(group.content_hash);
      const existingAfdKey = existing?.extracted &&
        typeof existing.extracted === 'object' &&
        !Array.isArray(existing.extracted)
        ? (existing.extracted as { afd_key?: unknown }).afd_key
        : undefined;
      if (typeof existingAfdKey === 'string' && existingAfdKey.length > 0) {
        await repo.markExtracted(group.ids, {
          afd_key: existingAfdKey,
          deduped_from_attachment_id: existing.id,
          uploaded_at: new Date().toISOString(),
        });
        result.uploaded++;
        log(`deduped ${group.ids.length} rows to existing AFD key (hash=${group.content_hash.slice(0, 8)})`);
        continue;
      }

      // 1. Download decoded bytes from mbox-archive S3.
      const bytes = await downloadFile(group.s3_key, group.s3_bucket);

      // 2. Build filename: type-prefix + original attachment name (or hash fallback).
      const mimeType = group.mime_type ?? 'application/pdf';
      const ext = mimeTypeToExtension(mimeType);
      const baseName = group.filename
        ? sanitiseFilename(group.filename)
        : `${group.content_hash.slice(0, 8)}.${ext}`;
      const prefix = group.doc_type ?? 'attachment';
      const fileName = `${prefix}_${baseName}`;

      // 3. Get presigned URL from AFD (target: mna-files bucket).
      const { uploadUrl, key } = await getPresignedUploadUrl(fileName, mimeType);

      // 4. PUT bytes to S3 via presigned URL.
      await putToS3(uploadUrl, bytes, mimeType);

      // 5. Notify AFD to process the uploaded file.
      //    Pass file_type_override only for mom / shopping_list / market_study;
      //    all other types let AFD's own LLM classify (avoids forcing HITL review).
      const fileTypeOverride = group.doc_type
        ? DOC_TYPE_TO_AFD_OVERRIDE[group.doc_type]
        : undefined;

      await notifyAfd({
        key,
        fileName,
        contentType: mimeType,
        fileTypeOverride,
        originEmail: true,
        bankerSource: group.banker_source,
        enteredBy: group.custodian_email,
      });

      // 6. Mark all rows sharing this hash as done.
      await repo.markExtracted(group.ids, { afd_key: key, uploaded_at: new Date().toISOString() });
      result.uploaded++;
      log(`uploaded ${group.ids.length} rows (hash=${group.content_hash.slice(0, 8)} type=${group.doc_type ?? 'pptx-direct'})`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`upload failed for hash=${group.content_hash.slice(0, 8)}: ${msg}`);
      for (const id of group.ids) {
        await repo.markFailed(id, `upload_error: ${msg}`);
      }
      result.failed++;
    }
  }

  log(`done: ${JSON.stringify(result)}`);
  return result;
}
