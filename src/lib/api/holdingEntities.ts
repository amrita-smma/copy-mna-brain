import { apiRequest } from '@/lib/api/client';
import type { Tables } from '@/lib/repositories';

type HoldingEntity = Tables<'holding_entities'>;

// Payload shapes are camelCase, matching each route's own `await req.json()`
// destructuring — NOT the snake_case DB row shape returned in responses.

export interface CreateHoldingEntityInput {
  name: string;
  holdingEntityType?: string | null;
  investedAmount?: number | null;
  realizedAmount?: number | null;
  fmvAmount?: number | null;
  dpi?: number | null;
  moic?: number | null;
  irr?: number | null;
  metricsComputedAt?: string | null;
}
export type UpdateHoldingEntityInput = Partial<CreateHoldingEntityInput>;

export function listHoldingEntities(): Promise<HoldingEntity[]> {
  return apiRequest<HoldingEntity[]>('/api/holding-entities');
}

export function createHoldingEntity(data: CreateHoldingEntityInput): Promise<HoldingEntity> {
  return apiRequest<HoldingEntity>('/api/holding-entities', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateHoldingEntity(
  id: string,
  data: UpdateHoldingEntityInput,
): Promise<HoldingEntity> {
  return apiRequest<HoldingEntity>(`/api/holding-entities/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export function deleteHoldingEntity(id: string): Promise<void> {
  return apiRequest<void>(`/api/holding-entities/${id}`, {
    method: 'DELETE',
  });
}
