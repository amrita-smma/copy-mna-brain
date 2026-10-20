import { apiRequest } from '@/lib/api/client';

export async function getCompanies(params: {
  id?: string;
  stage?: string;
  stageIn?: string[];
  excludeStage?: string;
  stageNotNull?: boolean;
  excludeDropped?: boolean;
  createdAfter?: string;
  orderBy?: string;
  orderDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}): Promise<any> {
  const search = new URLSearchParams();
  if (params.id) search.set('id', params.id);
  if (params.stage) search.set('stage', params.stage);
  if (params.stageIn?.length) search.set('stageIn', params.stageIn.join(','));
  if (params.excludeStage) search.set('excludeStage', params.excludeStage);
  if (typeof params.stageNotNull === 'boolean') search.set('stageNotNull', String(params.stageNotNull));
  if (typeof params.excludeDropped === 'boolean') search.set('excludeDropped', String(params.excludeDropped));
  if (params.createdAfter) search.set('createdAfter', params.createdAfter);
  if (params.orderBy) search.set('orderBy', params.orderBy);
  if (params.orderDir) search.set('orderDir', params.orderDir);
  if (params.limit) search.set('limit', String(params.limit));
  if (params.offset) search.set('offset', String(params.offset));

  return apiRequest<any>(`/api/companies?${search.toString()}`);
}

/**
 * Lightweight paginated company lookup — returns `{ id, target, project_name }[]`.
 * Used by the Smart Files "Matched Company" / "Project Name" pickers. Skips
 * DTO joins entirely, so each call is cheap and `q` (ILIKE matching either
 * `target` OR `project_name`) can be debounced as the user types.
 */
export async function getCompaniesLite(params: {
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<
  Array<{ id: string; target: string | null; project_name: string | null }>
> {
  const search = new URLSearchParams();
  search.set('lite', 'true');
  if (params.q) search.set('q', params.q);
  if (params.limit) search.set('limit', String(params.limit));
  if (params.offset) search.set('offset', String(params.offset));
  return apiRequest<
    Array<{ id: string; target: string | null; project_name: string | null }>
  >(`/api/companies?${search.toString()}`);
}

export async function getCompaniesCount(params: {
  stage?: string;
  createdAfter?: string;
  source?: 'inbound' | 'outbound';
  excludeDropped?: boolean;
}) {
  const search = new URLSearchParams();
  search.set('countOnly', 'true');
  if (params.stage) search.set('stage', params.stage);
  if (params.source) search.set('source', params.source);
  if (params.excludeDropped) search.set('excludeDropped', 'true');
  if (params.createdAfter) search.set('createdAfter', params.createdAfter);
  const data = await apiRequest<{ count: number }>(`/api/companies?${search.toString()}`);
  return data.count || 0;
}

/**
 * Per-stage company totals with the inbound/outbound split, aggregated
 * server-side. Replaces fetching every company just to tally stages in the
 * browser.
 */
export async function getCompanyStageCounts(params: {
  excludeDropped?: boolean;
  stageNotNull?: boolean;
  excludeStage?: string;
} = {}): Promise<
  Array<{ stage: string; count: number; inbound: number; outbound: number }>
> {
  const search = new URLSearchParams();
  search.set('countBy', 'stage');
  if (params.excludeDropped) search.set('excludeDropped', 'true');
  if (params.stageNotNull) search.set('stageNotNull', 'true');
  if (params.excludeStage) search.set('excludeStage', params.excludeStage);
  return apiRequest<
    Array<{ stage: string; count: number; inbound: number; outbound: number }>
  >(`/api/companies?${search.toString()}`);
}

/**
 * Enqueue an AI Opinion workforce run for a company. The run writes a firm
 * pass/fail/tentative verdict + ≤50-word rationale back onto the company; the
 * pipeline polls the companies list to surface it in the AI Opinion column.
 */
export async function analyzeAiOpinion(companyId: string): Promise<{ runId: string }> {
  return apiRequest<{ runId: string }>('/api/ai-opinion', {
    method: 'POST',
    body: JSON.stringify({ companyId }),
  });
}

export async function createCompany(company: any, logAction?: string) {
  return apiRequest<any>('/api/companies', {
    method: 'POST',
    body: JSON.stringify({ company, logAction }),
  });
}

export async function updateCompany(id: string, updates: Record<string, any>) {
  const rows = await apiRequest<any[]>('/api/companies', {
    method: 'PATCH',
    body: JSON.stringify({ id, updates }),
  });
  return rows?.[0] || null;
}

export async function bulkUpdateCompanies(ids: string[], updates: Record<string, any>, logAction?: string) {
  return apiRequest<any[]>('/api/companies', {
    method: 'PATCH',
    body: JSON.stringify({ ids, updates, logAction }),
  });
}

export async function deleteCompanyById(id: string) {
  return apiRequest<{ success: boolean }>(`/api/companies?id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function getCompanyDetails(id: string) {
  return apiRequest<{
    logs: any[];
    notes: any[];
    links: any[];
    documents: any[];
    screenings: any[];
    matchedFiles: any[];
  }>(`/api/companies/${encodeURIComponent(id)}/details`);
}

export interface FinancialEditRow {
  fiscal_year: number;
  revenue_usd_mn?: number | null;
  ebitda_usd_mn?: number | null;
  ev_usd_mn?: number | null;
}

export async function updateCompanyFinancials(
  id: string,
  payload: { rows: FinancialEditRow[]; deletedYears?: number[]; logAction?: string },
) {
  return apiRequest<any>(`/api/companies/${encodeURIComponent(id)}/financials`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function promoteCompany(id: string, payload: {
  currentStage?: string | null;
  nextStage: string;
  note?: string;
  linkUrl?: string;
  linkTitle?: string;
  assigneeIds?: string[];
  promotionReason?: string;
  /**
   * Telemetry only: whether the caller is about to attach a document.
   *
   * The attachment itself is uploaded separately (S3 + `/api/deal-documents`)
   * *after* this call returns, so the server cannot infer it. Passed explicitly
   * to keep the `has_document` property on `deal_promoted`, which existed while
   * that event was captured in the browser.
   */
  hasDocument?: boolean;
}) {
  return apiRequest<{ success: boolean }>(`/api/companies/${encodeURIComponent(id)}/promote`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export interface UserSummary {
  id: string;
  name: string;
  email: string | null;
  role: string | null;
}

export async function getUsers() {
  return apiRequest<UserSummary[]>('/api/users');
}

/**
 * Distinct banker ("Banker / Source") values already saved across companies,
 * for the creatable combobox in the pipeline edit dialogs.
 */
export async function getBankerNames(): Promise<string[]> {
  return apiRequest<string[]>('/api/companies?bankers=true');
}

export async function getCompanyAssignees(id: string) {
  return apiRequest<UserSummary[]>(`/api/companies/${encodeURIComponent(id)}/assignees`);
}

export async function setCompanyAssignees(id: string, userIds: string[]) {
  return apiRequest<{ success: boolean }>(`/api/companies/${encodeURIComponent(id)}/assignees`, {
    method: 'PUT',
    body: JSON.stringify({ userIds }),
  });
}

export async function dropDeal(id: string, payload: {
  currentStage?: string | null;
  reason?: string;
  /** ISO timestamp — when set, the deal is automatically resurfaced (reactivated) at this time. */
  resurfaceAt?: string | null;
}) {
  return apiRequest<{ success: boolean }>(`/api/companies/${encodeURIComponent(id)}/drop`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function bulkDropDeals(payload: {
  deals: Array<{ id: string; currentStage?: string | null }>;
  reason?: string;
}) {
  return apiRequest<{ success: boolean; count: number }>('/api/companies/drop-bulk', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function bulkPromoteDeals(payload: {
  deals: Array<{ id: string; currentStage?: string | null }>;
  nextStage: string;
}) {
  return apiRequest<{ success: boolean; count: number }>('/api/companies/promote-bulk', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function restoreDeal(id: string, payload: {
  currentStage?: string | null;
  /** Required when the deal's stage was deleted while it was dropped. */
  targetStage?: string;
}) {
  return apiRequest<{ success: boolean }>(`/api/companies/${encodeURIComponent(id)}/restore`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * @param createdAt ISO timestamp of when the entry happened, when the timeline
 * composer backdated it. Omitted means "now".
 */
export async function addCompanyNote(
  id: string,
  content: string,
  stage?: string | null,
  createdAt?: string | null,
) {
  return apiRequest<any>(`/api/companies/${encodeURIComponent(id)}/notes`, {
    method: 'POST',
    body: JSON.stringify({ content, stage, createdAt }),
  });
}

export async function addCompanyLink(
  id: string,
  url: string,
  title?: string,
  stage?: string | null,
  createdAt?: string | null,
  featured?: boolean,
) {
  return apiRequest<any>(`/api/companies/${encodeURIComponent(id)}/links`, {
    method: 'POST',
    body: JSON.stringify({ url, title, stage, createdAt, featured }),
  });
}

/** Features an existing attachment (PDF / PPTX / video / audio) as the company's Featured Slide. */
export async function featureDealDocument(dealId: string, documentId: string) {
  return apiRequest<{ success: boolean }>('/api/deal-documents/feature', {
    method: 'POST',
    body: JSON.stringify({ dealId, documentId }),
  });
}

/** Features an existing YouTube link as the company's Featured Slide. */
export async function featureDealLink(dealId: string, linkId: string) {
  return apiRequest<{ success: boolean }>('/api/deal-links/feature', {
    method: 'POST',
    body: JSON.stringify({ dealId, linkId }),
  });
}

/** Unfeatures whichever document or link is the company's Featured Slide. */
export async function clearFeaturedSlide(dealId: string) {
  return apiRequest<{ success: boolean }>(
    `/api/deal-documents/feature?dealId=${encodeURIComponent(dealId)}`,
    { method: 'DELETE' },
  );
}

/** Rewrites a timeline note's body in place. */
export async function updateDealNote(id: string, content: string) {
  return apiRequest<any>(`/api/deal-notes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ content }),
  });
}

export async function deleteDealNote(id: string) {
  return apiRequest<{ success: boolean }>(`/api/deal-notes/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function deleteDealLink(id: string) {
  return apiRequest<{ success: boolean }>(`/api/deal-links/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface Criteria {
  id: string;
  name: string;
  prompt: string;
  /** The Track (investment_thesis) this criterion belongs to. */
  investment_thesis_id: string;
  /** Has to pass for the track to pass; otherwise optional (counts toward the track's minimum). */
  must_pass: boolean;
}

/** All criteria, or — when `thesisId` is set — only those belonging to that Track. */
export async function getCriterias(thesisId?: string) {
  const qs = thesisId ? `?thesisId=${encodeURIComponent(thesisId)}` : '';
  return apiRequest<Criteria[]>(`/api/criterias${qs}`);
}

export async function createCriteria(
  name: string,
  prompt: string,
  investmentThesisId: string,
  mustPass = false,
) {
  return apiRequest<Criteria>('/api/criterias', {
    method: 'POST',
    body: JSON.stringify({ name, prompt, investmentThesisId, mustPass }),
  });
}

/** `mustPass` left undefined keeps the criterion's current flag. */
export async function updateCriteria(
  id: string,
  name: string,
  prompt: string,
  mustPass?: boolean,
) {
  return apiRequest<Criteria>(`/api/criterias/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name, prompt, mustPass }),
  });
}

export async function deleteCriteria(id: string) {
  return apiRequest<{ success: boolean }>(`/api/criterias/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/** How a Track variable's value is captured on the Company Card. */
export type TrackVariableType = 'textbox' | 'radio';

export interface TrackVariable {
  id: string;
  track_id: string;
  name: string;
  unit: string | null;
  type: TrackVariableType;
  /** Choices for `radio` type variables (empty for `textbox`). */
  options: string[] | null;
  sort_order: number | null;
}

/** All track variables, or — when `trackId` is set — only those for that Track. */
export async function getTrackVariables(trackId?: string) {
  const qs = trackId ? `?trackId=${encodeURIComponent(trackId)}` : '';
  return apiRequest<TrackVariable[]>(`/api/track-variables${qs}`);
}

export async function createTrackVariable(payload: {
  trackId: string;
  name: string;
  unit?: string | null;
  type?: TrackVariableType;
  options?: string[];
  sortOrder?: number;
}) {
  return apiRequest<TrackVariable>('/api/track-variables', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateTrackVariable(
  id: string,
  payload: {
    name?: string;
    unit?: string | null;
    type?: TrackVariableType;
    options?: string[];
    sortOrder?: number;
  },
) {
  return apiRequest<TrackVariable>(`/api/track-variables/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function deleteTrackVariable(id: string) {
  return apiRequest<{ success: boolean }>(`/api/track-variables/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

/**
 * `inScreening` limits to active Pending Confirmation and L0 companies — the
 * Pipeline's AI Screening panel.
 */
export async function getScreenings(params?: { companyId?: string; inScreening?: boolean }) {
  const search = new URLSearchParams();
  if (params?.companyId) search.set('companyId', params.companyId);
  if (params?.inScreening) search.set('inScreening', 'true');
  return apiRequest<any[]>(`/api/screenings${search.toString() ? `?${search.toString()}` : ''}`);
}

/**
 * A Pending Confirmation company's Run AI Screening: queue an AI Workforce
 * task that matches tracks if needed and screens the company. Rejects (409)
 * for a company not in Pending Confirmation.
 */
export function startAIScreening(companyId: string) {
  return apiRequest<{ alreadyQueued: boolean; trackCount: number; screeningCount: number }>(
    '/api/ai-screening',
    { method: 'POST', body: JSON.stringify({ companyId }) },
  );
}

export interface ScreeningGroupInput {
  companyId: string;
  trackId: string;
  criteriaIds: string[];
}

export async function prepareScreenings(groups: ScreeningGroupInput[]) {
  return apiRequest<
    Array<{ id: string; company_id: string; criteria_id: string; track_id: string | null }>
  >('/api/screenings/prepare', {
    method: 'POST',
    body: JSON.stringify({ groups }),
  });
}

export async function updateScreening(id: string, updates: Record<string, any>) {
  return apiRequest<any>(`/api/screenings/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export async function getActiveInvestmentThesis() {
  return apiRequest<any | null>('/api/investment-thesis');
}

export async function saveInvestmentThesis(payload: {
  id?: string;
  title: string;
  content: string;
  scan_frequency: string;
  sources_count: number;
  next_scan_at?: string;
}) {
  return apiRequest<any>('/api/investment-thesis', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// ── Tracks (backed by the investment_thesis table) ──────────────────────────
export interface Track {
  id: string;
  title: string | null;
  content: string | null;
  pic?: string | null;
  is_active?: boolean | null;
  scan_frequency?: string | null;
  sources_count?: number | null;
  last_scan_at?: string | null;
  next_scan_at?: string | null;
  /** Optional criteria that must pass for the track to pass screening; null = original rule. */
  min_optional_criteria_pass?: number | null;
}

/** All tracks (investment theses), newest first. */
export async function getTracks(): Promise<Track[]> {
  return apiRequest<Track[]>('/api/investment-thesis?all=1');
}

/**
 * Configure the AI market scanner: the active thesis set + shared scan cadence
 * and companies-per-scan. Returns the full thesis list (with updated is_active).
 */
export async function configureMarketScan(payload: {
  thesisIds: string[];
  scan_frequency?: string;
  sources_count?: number;
}): Promise<Track[]> {
  return apiRequest<Track[]>('/api/investment-thesis/active', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/** Create (no id) or update (with id) a track. */
export async function saveTrack(payload: {
  id?: string;
  title: string;
  content: string;
  pic?: string | null;
  min_optional_criteria_pass?: number | null;
}) {
  return apiRequest<Track>('/api/investment-thesis', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function deleteTrack(id: string) {
  return apiRequest<{ id: string }>(`/api/investment-thesis/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}
