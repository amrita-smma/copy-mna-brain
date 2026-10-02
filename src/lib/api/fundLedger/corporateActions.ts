import { apiRequest } from '../client';
import type {
  OwnershipContext,
  CorporateActionWriteInput,
  CorporateActionWriteResult,
  RecordCorporateActionInput,
} from '@/lib/services/flCorporateActionService';

export type {
  OwnershipContext,
  OwnershipChangeRequest,
  OwnershipChangeView,
  OwnershipPositionOption,
  CorporateActionView,
  CorporateActionWriteInput,
  CorporateActionWriteResult,
} from '@/lib/services/flCorporateActionService';

// ---- Corporate actions / ownership (MB-567) ----

/** Our positions in the company, their current stake, and its ownership history. */
export async function getOwnershipContext(assetId: string): Promise<OwnershipContext> {
  return apiRequest<OwnershipContext>(`/api/fund-ledger/assets/${assetId}/corporate-actions`);
}

export async function recordCorporateAction(
  assetId: string,
  input: Omit<RecordCorporateActionInput, 'asset_id' | 'created_by'>,
): Promise<CorporateActionWriteResult> {
  return apiRequest<CorporateActionWriteResult>(`/api/fund-ledger/assets/${assetId}/corporate-actions`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateCorporateAction(
  roundId: string,
  input: CorporateActionWriteInput,
): Promise<CorporateActionWriteResult> {
  return apiRequest<CorporateActionWriteResult>(`/api/fund-ledger/corporate-actions/${roundId}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function deleteCorporateAction(roundId: string): Promise<{ success: boolean }> {
  return apiRequest<{ success: boolean }>(`/api/fund-ledger/corporate-actions/${roundId}`, {
    method: 'DELETE',
  });
}
