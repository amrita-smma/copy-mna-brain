import { apiRequest } from '@/lib/api/client';
import type { Tables } from '@/lib/repositories';

export type CommitmentEventType =
  | 'initial_commitment'
  | 'additional_commitment'
  | 'reduction'
  | 'transfer_in'
  | 'transfer_out';

export type FundInvestorCommitmentEvent = Tables<'fund_investor_commitment_events'>;

export interface CommitmentEventWithBalance extends FundInvestorCommitmentEvent {
  delta: number;
  runningBalance: number;
}

export interface CreateCommitmentEventInput {
  fundId: string;
  holdingEntityId: string;
  effectiveDate: string;
  eventType: CommitmentEventType;
  amount: number;
  currency?: string;
  counterpartyHoldingEntityId?: string | null;
  notes?: string | null;
  source?: string | null;
}

export interface CreateCommitmentTransferInput {
  fundId: string;
  fromHoldingEntityId: string;
  toHoldingEntityId: string;
  effectiveDate: string;
  amount: number;
  currency?: string;
  notes?: string | null;
}

export interface UpdateCommitmentEventInput {
  effectiveDate?: string;
  eventType?: CommitmentEventType;
  amount?: number;
  currency?: string;
  notes?: string | null;
  counterpartyHoldingEntityId?: string | null;
}

export function listCommitmentEvents(params?: {
  fundId?: string;
  holdingEntityId?: string;
}): Promise<CommitmentEventWithBalance[]> {
  const query = new URLSearchParams();
  if (params?.fundId) query.set('fundId', params.fundId);
  if (params?.holdingEntityId) query.set('holdingEntityId', params.holdingEntityId);
  const qs = query.toString();
  return apiRequest<CommitmentEventWithBalance[]>(`/api/commitment-events${qs ? `?${qs}` : ''}`);
}

export function getCommitmentEvent(eventId: string): Promise<FundInvestorCommitmentEvent> {
  return apiRequest<FundInvestorCommitmentEvent>(`/api/commitment-events/${eventId}`);
}

export function createCommitmentEvent(
  data: CreateCommitmentEventInput,
): Promise<FundInvestorCommitmentEvent> {
  return apiRequest<FundInvestorCommitmentEvent>('/api/commitment-events', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function createCommitmentTransfer(
  data: CreateCommitmentTransferInput,
): Promise<{
  transferGroupId: string;
  fromEvent: FundInvestorCommitmentEvent;
  toEvent: FundInvestorCommitmentEvent;
}> {
  return apiRequest<{
    transferGroupId: string;
    fromEvent: FundInvestorCommitmentEvent;
    toEvent: FundInvestorCommitmentEvent;
  }>('/api/commitment-events/transfer', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateCommitmentEvent(
  eventId: string,
  data: UpdateCommitmentEventInput,
): Promise<FundInvestorCommitmentEvent> {
  return apiRequest<FundInvestorCommitmentEvent>(`/api/commitment-events/${eventId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function deleteCommitmentEvent(eventId: string): Promise<{ success: true }> {
  return apiRequest<{ success: true }>(`/api/commitment-events/${eventId}`, {
    method: 'DELETE',
  });
}
