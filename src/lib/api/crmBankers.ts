import { apiRequest } from '@/lib/api/client';
import type { BankerListSort } from '@/lib/repositories/bankerListRepository';
import type { BankerListResult, BankerRow } from '@/lib/services/bankerListService';

export type { BankerListResult, BankerListSort, BankerRow };

interface ListBankersParams {
  q?: string;
  sort?: BankerListSort;
  lastContact?: string | null;
  customDate?: string;
  clientTodayIso?: string;
  teamUserIds?: string[];
  hasDeals?: boolean;
  active30?: boolean;
  page?: number;
  pageSize?: number;
}

/** The CRM Bankers list: one row per person, sorted / filtered / paginated server-side. */
export function listBankers(params: ListBankersParams = {}): Promise<BankerListResult> {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.sort) search.set('sort', params.sort);
  if (params.lastContact) search.set('lastContact', params.lastContact);
  if (params.customDate) search.set('customDate', params.customDate);
  if (params.clientTodayIso) search.set('clientTodayIso', params.clientTodayIso);
  if (params.teamUserIds && params.teamUserIds.length > 0) {
    search.set('team', params.teamUserIds.join(','));
  }
  if (params.hasDeals) search.set('hasDeals', '1');
  if (params.active30) search.set('active30', '1');
  if (params.page) search.set('page', String(params.page));
  if (params.pageSize) search.set('pageSize', String(params.pageSize));
  const qs = search.toString();
  return apiRequest<BankerListResult>(`/api/crm/contacts${qs ? `?${qs}` : ''}`);
}
