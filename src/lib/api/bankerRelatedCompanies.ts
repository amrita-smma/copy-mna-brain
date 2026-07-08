import { apiRequest } from '@/lib/api/client';
import type { BankerRelatedCompaniesRow } from '@/lib/services/crmService';

/**
 * Fetch bankers ranked by the number of related companies attached to each
 * (descending). Pass `limit` to request only the top-N (the dashboard card);
 * omit it for the full ranking (the Banker Related Companies page).
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
