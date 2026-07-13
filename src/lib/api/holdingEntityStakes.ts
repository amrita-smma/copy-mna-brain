import { apiRequest } from '@/lib/api/client';
import type { Tables } from '@/lib/repositories';

type FundHoldingEntityStake = Tables<'fund_holding_entity_stakes'>;

export interface UpsertStakeInput {
  fundId: string;
  holdingEntityId: string;
  commitmentAmount?: number | null;
  commitmentAmountCurrency?: string;
  investedAmount?: number | null;
  investedAmountCurrency?: string;
}

export function listHoldingEntityStakes(): Promise<FundHoldingEntityStake[]> {
  return apiRequest<FundHoldingEntityStake[]>('/api/holding-entity-stakes');
}

export function upsertHoldingEntityStake(data: UpsertStakeInput): Promise<FundHoldingEntityStake> {
  return apiRequest<FundHoldingEntityStake>('/api/holding-entity-stakes', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function deleteHoldingEntityStake(stakeId: string): Promise<{ success: true }> {
  return apiRequest<{ success: true }>(`/api/holding-entity-stakes/${stakeId}`, {
    method: 'DELETE',
  });
}
