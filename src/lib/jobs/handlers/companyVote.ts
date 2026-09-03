import type { DbClient } from '@/lib/repositories';

export const COMPANY_VOTE_TIMEOUT_SECONDS = 300;

/**
 * Background half of a vote transition, queued as a `company_vote` job so the
 * user's click returns immediately.
 *
 *  - `invite`: build the Company Card .pptx once and email it to every voter.
 *  - `conclude`: run the AI synthesis over the ballots and recap the round to
 *    the initiator and all voters.
 */
export type CompanyVotePayload =
  | { kind: 'invite'; sessionId: string; workspaceId?: string }
  | {
      kind: 'conclude';
      sessionId: string;
      reason: 'all_submitted' | 'deadline';
      workspaceId?: string;
    };

export interface CompanyVoteJobResult {
  kind: CompanyVotePayload['kind'];
  sessionId: string;
  /** Invitation fan-out counts; absent for `conclude`. */
  sent?: number;
  failed?: number;
}

export async function runCompanyVote(
  payload: CompanyVotePayload,
  deps: { db: DbClient },
): Promise<CompanyVoteJobResult> {
  if (!payload?.sessionId) throw new Error('company_vote: `sessionId` is required');
  if (!payload.workspaceId) throw new Error('company_vote: `workspaceId` is required');

  // Imported lazily: the container transitively reaches CompanyVoteService,
  // which dispatches this job — a static import would close that cycle.
  const { createContainer } = await import('@/lib/services/container');
  const { companyVoteService } = createContainer(deps.db, payload.workspaceId);

  switch (payload.kind) {
    case 'invite': {
      const result = await companyVoteService.deliverInvitations(payload.sessionId);
      return { kind: 'invite', sessionId: payload.sessionId, ...result };
    }
    case 'conclude': {
      await companyVoteService.finalizeConcludedSession(payload.sessionId, payload.reason);
      return { kind: 'conclude', sessionId: payload.sessionId };
    }
    default: {
      // Exhaustiveness check — a new `kind` without a case here won't compile.
      const _exhaustive: never = payload;
      throw new Error(
        `company_vote: unsupported kind ${String((_exhaustive as { kind?: unknown }).kind)}`,
      );
    }
  }
}
