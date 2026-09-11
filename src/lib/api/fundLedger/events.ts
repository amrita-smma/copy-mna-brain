import { apiRequest } from '../client';
import type { Tables } from '@/lib/repositories';
import type {
  PostEventInput,
  UpdateEventInput,
  ReverseEventInput,
} from './types';

// ---- Ledger Events & Entries ----

export async function postEvent(input: PostEventInput) {
  return apiRequest<unknown>('/api/fund-ledger/events', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function getEvent(id: string) {
  return apiRequest<{
    event: Tables<'fl_business_events'>;
    entries: Tables<'fl_ledger_entries'>[];
    allocations: Tables<'fl_ledger_entry_funding_allocations'>[];
  }>(`/api/fund-ledger/events/${id}`);
}

export async function updateEvent(id: string, input: UpdateEventInput) {
  return apiRequest<unknown>(`/api/fund-ledger/events/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function reverseEvent(id: string, input?: ReverseEventInput) {
  return apiRequest<unknown>(`/api/fund-ledger/events/${id}`, {
    method: 'DELETE',
    body: input ? JSON.stringify(input) : undefined,
  });
}

export async function listEntries(params: {
  positionIds: string[] | string;
  limit?: number;
  offset?: number;
}): Promise<Tables<'fl_ledger_entries'>[]> {
  const ids = Array.isArray(params.positionIds) ? params.positionIds : [params.positionIds];
  const cleanIds = ids.filter(Boolean);
  if (cleanIds.length === 0) {
    return [];
  }
  const searchParams = new URLSearchParams();
  searchParams.set('positionIds', cleanIds.join(','));
  if (params.limit !== undefined) searchParams.set('limit', String(params.limit));
  if (params.offset !== undefined) searchParams.set('offset', String(params.offset));
  const q = searchParams.toString();
  return apiRequest<Tables<'fl_ledger_entries'>[]>(
    `/api/fund-ledger/entries?${q}`,
  );
}
