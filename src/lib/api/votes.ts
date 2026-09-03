import { apiRequest } from '@/lib/api/client';
import type { VoteTabState } from '@/lib/services/companyVoteService';
import type { VoteChoice } from '@/lib/voting/tally';

export type { VoteTabState };

/**
 * Client wrappers for the company voting endpoints. Every mutation returns the
 * freshly recomputed tab state so the view never has to follow a write with a
 * second GET.
 */

const votePath = (companyId: string) =>
  `/api/companies/${encodeURIComponent(companyId)}/vote`;

export function getVoteState(companyId: string): Promise<VoteTabState> {
  return apiRequest<VoteTabState>(votePath(companyId));
}

export function startVote(
  companyId: string,
  payload: { voterIds: string[]; durationDays: number; durationHours: number },
): Promise<VoteTabState> {
  return apiRequest<VoteTabState>(votePath(companyId), {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * Save a draft ballot, or submit it (`submit: true`). Omitting `choice` or
 * `bodyHtml` leaves that field as stored.
 */
export function saveBallot(
  companyId: string,
  payload: {
    sessionId: string;
    choice?: VoteChoice | null;
    bodyHtml?: string | null;
    submit?: boolean;
  },
): Promise<VoteTabState> {
  return apiRequest<VoteTabState>(`${votePath(companyId)}/ballot`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

/** Initiator only: abandon the round. */
export function cancelVote(
  companyId: string,
  sessionId: string,
): Promise<VoteTabState> {
  return apiRequest<VoteTabState>(votePath(companyId), {
    method: 'PATCH',
    body: JSON.stringify({ action: 'cancel', sessionId }),
  });
}

/** Initiator only: reopen every submitted ballot for revision. */
export function sendBackSubmissions(
  companyId: string,
  sessionId: string,
): Promise<VoteTabState> {
  return apiRequest<VoteTabState>(votePath(companyId), {
    method: 'PATCH',
    body: JSON.stringify({ action: 'send_back', sessionId }),
  });
}
