import { apiRequest } from '../client';
import type { Tables } from '@/lib/repositories';
import type { RecordValuationInput, UpdateValuationInput } from './types';

// ---- Valuations ----

export async function listValuations(params?: {
  assetId?: string;
  fundId?: string;
  positionId?: string;
  asOf?: string;
  series?: boolean;
}): Promise<Tables<'fl_valuations'>[]> {
  const searchParams = new URLSearchParams();
  if (params?.assetId) searchParams.set('assetId', params.assetId);
  if (params?.fundId) searchParams.set('fundId', params.fundId);
  if (params?.positionId) searchParams.set('positionId', params.positionId);
  if (params?.asOf) searchParams.set('asOf', params.asOf);
  if (params?.series) searchParams.set('series', 'true');
  const q = searchParams.toString();
  return apiRequest<Tables<'fl_valuations'>[]>(
    `/api/fund-ledger/valuations${q ? `?${q}` : ''}`,
  );
}

export async function getValuation(id: string): Promise<Tables<'fl_valuations'>> {
  return apiRequest<Tables<'fl_valuations'>>(`/api/fund-ledger/valuations/${id}`);
}

export async function recordValuation(input: RecordValuationInput): Promise<Tables<'fl_valuations'>> {
  return apiRequest<Tables<'fl_valuations'>>('/api/fund-ledger/valuations', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateValuation(
  id: string,
  input: UpdateValuationInput,
): Promise<Tables<'fl_valuations'>> {
  return apiRequest<Tables<'fl_valuations'>>(`/api/fund-ledger/valuations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function deleteValuation(id: string): Promise<{ success: boolean }> {
  return apiRequest<{ success: boolean }>(`/api/fund-ledger/valuations/${id}`, {
    method: 'DELETE',
  });
}
