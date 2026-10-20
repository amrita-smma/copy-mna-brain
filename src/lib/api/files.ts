import { apiRequest } from '@/lib/api/client';

export interface FileSearchResult {
  id: string;
  file_name: string;
  file_link: string;
}

/**
 * Lists/searches files in the active workspace via the same endpoint
 * `/api/smart-files`'s own table view uses. With `search` omitted this just
 * lists every file (sorted however `sortField`/`sortDirection` say), which is
 * what a "browse" dropdown wants before the user has typed anything; with
 * `search` set it matches on file_name, tags, and matched company names.
 * Callers filter the result kind themselves (e.g. to only "presentable"
 * file types).
 *
 * Passes `lite=true` so the route skips signing an S3 URL for every result —
 * signed URLs cost a real S3 API round-trip each, and a search/browse
 * dropdown only ever needs the file's name/key to let the user pick one.
 */
export async function searchFiles(params: {
  search?: string;
  limit?: number;
  offset?: number;
  sortField?: 'file_name' | 'file_date' | 'processing_status' | 'created_at';
  sortDirection?: 'asc' | 'desc';
}): Promise<FileSearchResult[]> {
  const pageSize = params.limit ?? 20;
  const page = Math.floor((params.offset ?? 0) / pageSize) + 1;
  const query = new URLSearchParams({
    pageSize: String(pageSize),
    page: String(page),
    lite: 'true',
  });
  if (params.search) query.set('search', params.search);
  if (params.sortField) query.set('sortField', params.sortField);
  if (params.sortDirection) query.set('sortDirection', params.sortDirection);
  return apiRequest<FileSearchResult[]>(`/api/smart-files?${query.toString()}`);
}

export interface SmartFileUploadOptions {
  /** Forces the Smart Files category (e.g. `'fund_updates'`); omit for AI classification. */
  fileTypeOverride?: string;
  rawNotes?: string;
}

export interface SmartFileUploadResult {
  /** The `files` row id (the existing row when `duplicate` is true). */
  id: string | null;
  /** True when a file with this name already existed and was returned as-is. */
  duplicate: boolean;
  /** True when processing continues in a background job. */
  isAsync: boolean;
  asyncSecondaryWorkspacesSkipped: boolean;
}

/**
 * Uploads one file through the Smart Files pipeline: presigned URL → direct S3
 * PUT → `POST /api/smart-files`, which inserts the row and runs (or queues) the
 * file-processing / fund-update agents. Throws on any failed step.
 */
export async function uploadSmartFile(
  file: File,
  options: SmartFileUploadOptions = {},
): Promise<SmartFileUploadResult> {
  const fileName = file.name;
  const contentType = file.type || 'application/octet-stream';

  const presignedResponse = await fetch(
    `/api/smart-files/upload-url?${new URLSearchParams({ fileName, contentType }).toString()}`,
  );
  const presignedResult = await presignedResponse.json();
  if (!presignedResult.success) {
    throw new Error(presignedResult.error || 'Failed to get upload URL');
  }
  const { uploadUrl, key } = presignedResult.data;

  const s3Response = await fetch(uploadUrl, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': contentType },
  });
  if (!s3Response.ok) {
    throw new Error('Failed to upload file to S3');
  }

  const body: Record<string, unknown> = { key, fileName, contentType };
  if (options.rawNotes) body.raw_notes = options.rawNotes;
  if (options.fileTypeOverride) body.file_type_override = options.fileTypeOverride;

  const notifyResponse = await fetch('/api/smart-files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const notifyResult = await notifyResponse.json();
  if (!notifyResponse.ok || !notifyResult.success) {
    throw new Error(notifyResult.error || `Processing failed for ${fileName}`);
  }

  const data = notifyResult.data ?? {};
  return {
    id: typeof data.id === 'string' ? data.id : null,
    duplicate: data.duplicate === true,
    isAsync: notifyResponse.status === 202 || Boolean(data.jobId),
    asyncSecondaryWorkspacesSkipped: Boolean(data.asyncSecondaryWorkspacesSkipped),
  };
}

export interface SmartFileStatus {
  id: string;
  file_name: string;
  file_type: string;
  processing_status: string | null;
}

/** Reads one file's processing status (`GET /api/smart-files/:id`). */
export async function getSmartFileStatus(id: string): Promise<SmartFileStatus> {
  const response = await fetch(`/api/smart-files/${encodeURIComponent(id)}`);
  const result = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error || 'Failed to load file');
  }
  return result.data as SmartFileStatus;
}

/**
 * Re-runs AI extraction on a file (`POST /api/smart-files/:id/reprocess`).
 * Resolves `{ isAsync: true }` when processing continues in a background job.
 * Throws with the server's message on failure.
 */
export async function reprocessSmartFile(id: string): Promise<{ isAsync: boolean }> {
  const response = await fetch(`/api/smart-files/${encodeURIComponent(id)}/reprocess`, {
    method: 'POST',
  });
  const result = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(result.error || 'Failed to reprocess file');
  }
  return { isAsync: response.status === 202 || Boolean(result.data?.jobId) };
}

/**
 * Downloads the original file through a short-lived signed URL
 * (`GET /api/smart-files/:id/download`). Throws when no URL is issued.
 */
export async function downloadSmartFile(id: string, fileName: string): Promise<void> {
  const response = await fetch(`/api/smart-files/${encodeURIComponent(id)}/download`);
  if (!response.ok) throw new Error('Failed to generate download URL');

  const { download_url } = await response.json();
  if (!download_url) throw new Error('Download URL not provided');

  const link = document.createElement('a');
  link.href = download_url;
  link.setAttribute('download', fileName);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
