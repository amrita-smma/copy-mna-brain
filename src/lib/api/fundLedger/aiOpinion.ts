import { apiRequest } from '../client';

// ---- AI Opinion ----

export async function triggerAiOpinion(assetId: string): Promise<unknown> {
  return apiRequest<unknown>(`/api/fund-ledger/assets/${assetId}/ai-opinion`, {
    method: 'POST',
  });
}

export async function clearAiOpinion(assetId: string): Promise<unknown> {
  return apiRequest<unknown>(`/api/fund-ledger/assets/${assetId}/ai-opinion`, {
    method: 'DELETE',
  });
}

export async function getAiOpinion(assetId: string): Promise<unknown> {
  return apiRequest<{ ai_opinion: unknown }>(
    `/api/fund-ledger/assets/${assetId}/ai-opinion`,
  );
}
