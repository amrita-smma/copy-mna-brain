import { apiRequest } from '../client';
import type { Tables } from '@/lib/repositories';
import type { OpenPositionInput } from './types';

// ---- Positions ----

export async function listPositions(params?: {
  fundId?: string;
  holderInvestorId?: string;
  holderFundId?: string;
  assetId?: string;
  holderSourceOfFundId?: string | null;
}): Promise<Tables<'fl_positions'>[]> {
  const searchParams = new URLSearchParams();
  if (params?.fundId) searchParams.set('fundId', params.fundId);
  if (params?.holderInvestorId) searchParams.set('holderInvestorId', params.holderInvestorId);
  if (params?.holderFundId) searchParams.set('holderFundId', params.holderFundId);
  if (params?.assetId) searchParams.set('assetId', params.assetId);
  if (params?.holderSourceOfFundId !== undefined) searchParams.set('holderSourceOfFundId', params.holderSourceOfFundId === null ? 'null' : params.holderSourceOfFundId);
  const q = searchParams.toString();
  return apiRequest<Tables<'fl_positions'>[]>(
    `/api/fund-ledger/positions${q ? `?${q}` : ''}`,
  );
}

export async function getPosition(id: string): Promise<Tables<'fl_positions'>> {
  return apiRequest<Tables<'fl_positions'>>(`/api/fund-ledger/positions/${id}`);
}

export async function openPosition(input: OpenPositionInput): Promise<Tables<'fl_positions'>> {
  return apiRequest<Tables<'fl_positions'>>('/api/fund-ledger/positions', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function closePosition(
  id: string,
  input?: { closed_at?: string; notes?: string },
): Promise<Tables<'fl_positions'>> {
  return apiRequest<Tables<'fl_positions'>>(
    `/api/fund-ledger/positions/${id}/close`,
    {
      method: 'POST',
      body: JSON.stringify(input ?? {}),
    },
  );
}

export async function closePositions(
  positionIds: string[],
  input?: { closed_at?: string; closedAt?: string },
): Promise<Tables<'fl_positions'>[]> {
  if (positionIds.length === 0) {
    return [];
  }
  return apiRequest<Tables<'fl_positions'>[]>(
    '/api/fund-ledger/positions/batch-close',
    {
      method: 'POST',
      body: JSON.stringify({
        position_ids: positionIds,
        closed_at: input?.closed_at ?? input?.closedAt,
      }),
    },
  );
}

export async function reopenPosition(
  id: string,
): Promise<Tables<'fl_positions'>> {
  return apiRequest<Tables<'fl_positions'>>(
    `/api/fund-ledger/positions/${id}/reopen`,
    {
      method: 'POST',
    },
  );
}
