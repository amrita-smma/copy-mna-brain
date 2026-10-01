import { apiRequest } from '@/lib/api/client';
import type {
  InsightChatContext,
  InsightSummary,
  InsightDetail,
  InsightHead,
  InsightFailedRefreshRun,
  InsightKind,
  InsightListPage,
  InsightListQuery,
} from '@/lib/insights/types';
import { buildInsightListSearch } from '@/lib/insights/listQuery';

export interface CreateInsightFromDocumentParams {
  name: string;
  description?: string | null;
  html: string;
  kind?: InsightKind;
  /**
   * The CoPilot chat the approved card came from. The server stamps v1 with
   * that thread's pinned agent (MB-549); omit it outside a chat.
   */
  chat_id?: string | null;
  /**
   * The insight template the document was built on. The server records it as
   * the insight's source when it is a live template in the workspace, and
   * ignores it otherwise.
   */
  template_id?: string | null;
}

export interface PublishInsightVersionParams {
  html: string;
  label?: string | null;
  baseVersionNo?: number | null;
  /** The CoPilot chat the approved card came from, for the agent stamp (MB-549). */
  chat_id?: string | null;
}

export interface RollbackInsightParams {
  toVersionNo: number;
}

/**
 * Fetch one page of the active workspace's insights and the total matching
 * the query: live ones by default (featured first, then newest updated), or
 * archived ones with `archived`. 50 rows per page unless `limit` says
 * otherwise (at most 100) — page with `offset` to reach the rest.
 */
export async function listInsights(query: InsightListQuery = {}): Promise<InsightListPage> {
  return apiRequest<InsightListPage>(`/api/insights${buildInsightListSearch(query)}`);
}

/**
 * Fetch a single insight by ID with its version history and HTML (latest or specific ?version=N).
 */
export async function getInsight(
  id: string,
  versionNo?: number,
): Promise<InsightDetail> {
  const url =
    versionNo !== undefined
      ? `/api/insights/${encodeURIComponent(id)}?version=${versionNo}`
      : `/api/insights/${encodeURIComponent(id)}`;
  return apiRequest<InsightDetail>(url);
}

/**
 * The insight's refresh runs that failed or were cancelled (newest 50), for
 * its version history.
 */
export async function listInsightFailedRefreshRuns(
  id: string,
): Promise<InsightFailedRefreshRun[]> {
  return apiRequest<InsightFailedRefreshRun[]>(
    `/api/insights/${encodeURIComponent(id)}/refresh-runs`,
  );
}

/**
 * The fields of an insight's refresh routine the insight face reads — whether
 * it runs, and why the system paused it (MB-560). The endpoint answers with the
 * whole routine row; only these are relied on here.
 */
export interface InsightRefreshRoutineStatus {
  id: string;
  enabled: boolean;
  paused_reason: string | null;
  paused_at: string | null;
}

/**
 * The insight's active refresh routine, or null when it has none.
 */
export async function getInsightRefreshRoutine(
  id: string,
): Promise<InsightRefreshRoutineStatus | null> {
  const routine = await apiRequest<InsightRefreshRoutineStatus | null>(
    `/api/insights/${encodeURIComponent(id)}/refresh-routine`,
  );
  return routine ?? null;
}

/** What "Refresh this insight now" did (MB-552). */
export interface InsightRefreshNowResult {
  runId: string;
  /** false when a refresh of the insight was already queued or running. */
  created: boolean;
  /** The insight's refresh routine, or null for a one-off refresh run. */
  routineId: string | null;
}

/**
 * Refresh the insight now: through its refresh routine when it has one, else
 * as a one-off refresh run. Rejects with a 409 when the binding is paused.
 */
export async function refreshInsightNow(id: string): Promise<InsightRefreshNowResult> {
  return apiRequest<InsightRefreshNowResult>(
    `/api/insights/${encodeURIComponent(id)}/refresh-now`,
    { method: 'POST' },
  );
}

/**
 * The outline of the insight's current version that CoPilot turns carry while
 * it is open (MB-550), for the "context in use" panel. Rejects with a 404 when
 * the insight is missing or archived.
 */
export async function getInsightChatContext(id: string): Promise<InsightChatContext> {
  return apiRequest<InsightChatContext>(
    `/api/insights/${encodeURIComponent(id)}/chat-context`,
  );
}

/**
 * The insight's current version number, publish time and trigger, without its
 * HTML (MB-554) — what an open edit card polls to notice a moved base.
 * Rejects with a 404 when the insight is missing or archived.
 */
export async function getInsightHead(id: string): Promise<InsightHead> {
  return apiRequest<InsightHead>(`/api/insights/${encodeURIComponent(id)}/head`);
}

/**
 * Fetch just an insight's latest HTML, for the hover preview.
 */
export async function getInsightHtml(id: string): Promise<string> {
  const detail = await getInsight(id);
  return detail.html;
}

/**
 * Create an insight from a document the CoPilot proposed and the user approved.
 * Writes the insight and its version 1 in one transaction.
 */
export async function createInsightFromDocument(
  params: CreateInsightFromDocumentParams,
): Promise<InsightDetail> {
  return apiRequest<InsightDetail>('/api/insights', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export interface UploadInsightFileParams {
  file: File;
  /** Blank lets the server name it after the document's <title> or the file. */
  name?: string;
  description?: string;
}

/**
 * Create an insight from an HTML file (MB-635). Sent as multipart form-data:
 * a JSON-escaped document near the 4 MB cap would exceed the request limit.
 */
export async function uploadInsightFile(params: UploadInsightFileParams): Promise<InsightDetail> {
  const form = new FormData();
  form.append('file', params.file);
  if (params.name?.trim()) form.append('name', params.name.trim());
  if (params.description?.trim()) form.append('description', params.description.trim());
  return apiRequest<InsightDetail>('/api/insights/upload', { method: 'POST', body: form });
}

/**
 * Rename an existing insight.
 */
export async function renameInsight(
  id: string,
  name: string,
): Promise<InsightSummary> {
  return apiRequest<InsightSummary>(`/api/insights/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  });
}

/**
 * Mark an insight as featured (or unfeatured).
 */
export async function featureInsight(
  id: string,
  isFeatured = true,
): Promise<InsightSummary> {
  return apiRequest<InsightSummary>(`/api/insights/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ is_featured: isFeatured }),
  });
}

/**
 * Bind an insight to a sector agent by registry key, or pass `null` to unbind
 * it (back to the general CoPilot). Takes effect from the next CoPilot session
 * or scheduled refresh; past versions are untouched.
 */
export async function setInsightAgentBinding(
  id: string,
  agentKey: string | null,
): Promise<InsightSummary> {
  return apiRequest<InsightSummary>(`/api/insights/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ agent_key: agentKey }),
  });
}

/**
 * Soft-delete / archive an insight.
 */
export async function archiveInsight(id: string): Promise<InsightSummary> {
  return apiRequest<InsightSummary>(`/api/insights/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/**
 * Restore an archived insight to the live list. It comes back unfeatured.
 * Rejects with a 404 when the insight is missing or not archived.
 */
export async function restoreInsight(id: string): Promise<InsightSummary> {
  return apiRequest<InsightSummary>(`/api/insights/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ archive: false }),
  });
}

/**
 * Permanently delete an insight and all its versions. Irreversible.
 */
export async function deleteInsightPermanently(id: string): Promise<void> {
  return apiRequest<void>(
    `/api/insights/${encodeURIComponent(id)}?hard=true`,
    {
      method: 'DELETE',
    },
  );
}

/**
 * Publish a new version of an insight (increments version_no).
 */
export async function publishInsightVersion(
  id: string,
  params: PublishInsightVersionParams,
): Promise<InsightDetail> {
  return apiRequest<InsightDetail>(`/api/insights/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

/**
 * Rollback to a previous version number by copying HTML and appending a new version.
 */
export async function rollbackInsight(
  id: string,
  params: RollbackInsightParams,
): Promise<InsightDetail> {
  return apiRequest<InsightDetail>(
    `/api/insights/${encodeURIComponent(id)}/rollback`,
    {
      method: 'POST',
      body: JSON.stringify(params),
    },
  );
}

/** Duplicate an insight: a new insight whose v1 is the source's current HTML. */
export async function duplicateInsight(id: string): Promise<InsightDetail> {
  return apiRequest<InsightDetail>(
    `/api/insights/${encodeURIComponent(id)}/duplicate`,
    {
      method: 'POST',
    },
  );
}
