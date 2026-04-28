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

  return apiRequest<any>(`/api/companies?${search.toString()}`);
}

export async function getCompaniesCount(params: {
  stage?: string;
  createdAfter?: string;
}) {
  const search = new URLSearchParams();
  search.set('countOnly', 'true');
  if (params.stage) search.set('stage', params.stage);
  if (params.createdAfter) search.set('createdAfter', params.createdAfter);
  const data = await apiRequest<{ count: number }>(`/api/companies?${search.toString()}`);
  return data.count || 0;
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
}) {
  return apiRequest<{ success: boolean }>(`/api/companies/${encodeURIComponent(id)}/drop`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function restoreDeal(id: string, payload: {
  currentStage?: string | null;
}) {
  return apiRequest<{ success: boolean }>(`/api/companies/${encodeURIComponent(id)}/restore`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function runCompanyL1Filters(id: string) {
  return apiRequest<any>(`/api/companies/${encodeURIComponent(id)}/run-l1-filters`, {
    method: 'POST',
  });
}

export async function addCompanyNote(id: string, content: string, stage?: string | null) {
  return apiRequest<any>(`/api/companies/${encodeURIComponent(id)}/notes`, {
    method: 'POST',
    body: JSON.stringify({ content, stage }),
  });
}

export async function addCompanyLink(id: string, url: string, title?: string, stage?: string | null) {
  return apiRequest<any>(`/api/companies/${encodeURIComponent(id)}/links`, {
    method: 'POST',
    body: JSON.stringify({ url, title, stage }),
  });
}

export async function deleteDealNote(id: string) {
  return apiRequest<{ success: boolean }>(`/api/deal-notes/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function deleteDealLink(id: string) {
  return apiRequest<{ success: boolean }>(`/api/deal-links/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function getCriterias() {
  return apiRequest<any[]>('/api/criterias');
}

export async function createCriteria(name: string, prompt: string) {
  return apiRequest<any>('/api/criterias', {
    method: 'POST',
    body: JSON.stringify({ name, prompt }),
  });
}

export async function updateCriteria(id: string, name: string, prompt: string) {
  return apiRequest<any>(`/api/criterias/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name, prompt }),
  });
}

export async function deleteCriteria(id: string) {
  return apiRequest<{ success: boolean }>(`/api/criterias/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function getScreenings(params?: { companyId?: string; onlyL0?: boolean }) {
  const search = new URLSearchParams();
  if (params?.companyId) search.set('companyId', params.companyId);
  if (params?.onlyL0) search.set('onlyL0', 'true');
  return apiRequest<any[]>(`/api/screenings${search.toString() ? `?${search.toString()}` : ''}`);
}

export async function prepareScreenings(companyIds: string[], criteriaIds: string[]) {
  return apiRequest<Array<{ id: string; company_id: string; criteria_id: string }>>('/api/screenings/prepare', {
    method: 'POST',
    body: JSON.stringify({ companyIds, criteriaIds }),
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

export async function getFavoriteCompanies(userId: string): Promise<string[]> {
  return apiRequest<string[]>(`/api/users/${encodeURIComponent(userId)}/favorites`);
}

export async function toggleFavoriteCompany(userId: string, companyId: string): Promise<string[]> {
  return apiRequest<string[]>(`/api/users/${encodeURIComponent(userId)}/favorites`, {
    method: 'PATCH',
    body: JSON.stringify({ companyId }),
  });
}
