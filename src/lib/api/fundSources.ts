import { apiRequest } from '@/lib/api/client';
import type { Tables } from '@/lib/repositories';

type FundSource = Tables<'funding_sources'>;

// Payload shapes are camelCase, matching each route's own `await req.json()`
// destructuring — NOT the snake_case DB row shape returned in responses.

export interface CreateFundSourceInput {
  name: string;
  investedAmount?: number | null;
  realizedAmount?: number | null;
  fmvAmount?: number | null;
  dpi?: number | null;
  moic?: number | null;
  irr?: number | null;
  metricsComputedAt?: string | null;
}
export type UpdateFundSourceInput = Partial<CreateFundSourceInput>;

export function listFundSources(): Promise<FundSource[]> {
  return apiRequest<FundSource[]>('/api/fund-sources');
}

export function createFundSource(data: CreateFundSourceInput): Promise<FundSource> {
  return apiRequest<FundSource>('/api/fund-sources', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateFundSource(
  sourceId: string,
  updates: UpdateFundSourceInput,
): Promise<FundSource> {
  return apiRequest<FundSource>(`/api/fund-sources/${sourceId}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  });
}

export function deleteFundSource(sourceId: string): Promise<{ success: true }> {
  return apiRequest<{ success: true }>(`/api/fund-sources/${sourceId}`, {
    method: 'DELETE',
  });
}
