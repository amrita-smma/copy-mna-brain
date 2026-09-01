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
