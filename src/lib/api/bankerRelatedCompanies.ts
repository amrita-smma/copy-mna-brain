import { apiRequest } from '@/lib/api/client';
import type { BankerRelatedCompaniesRow } from '@/lib/services/crmService';

/**
 * Fetch bankers ranked by the number of related companies attached to each
 * (descending). Backs the dashboard "Banker related companies" card, which
 * fetches the full ranking and paginates it client-side. Pass `limit` to cap
 * the result to a top-N.
 */
export async function getBankerRelatedCompanies(params?: {
  limit?: number;
}): Promise<BankerRelatedCompaniesRow[]> {
  const search = new URLSearchParams();
  if (params?.limit != null) search.set('limit', String(params.limit));
  const qs = search.toString();
  return apiRequest<BankerRelatedCompaniesRow[]>(
    `/api/crm/banker-related-companies${qs ? `?${qs}` : ''}`,
  );
}
