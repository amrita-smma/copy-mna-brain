import { apiRequest } from '@/lib/api/client';
import type { ActionCardDecision, ActionCardDecisionStatus } from '@/lib/chat/actionCards';

export interface SaveCardDecisionResult {
  decision: ActionCardDecision;
  /** The card was decided already (on another device, say); `decision` is that one. */
  alreadyDecided: boolean;
}

/**
 * Record the caller's decision on an action card in their chat. The first
 * decision stands; resolves to the stored one.
 */
export function saveCardDecision(
  chatId: string,
  cardId: string,
  input: {
    toolName: string;
    status: ActionCardDecisionStatus;
    resolutionText: string | null;
    data?: Record<string, unknown> | null;
  },
): Promise<SaveCardDecisionResult> {
  return apiRequest<SaveCardDecisionResult>(
    `/api/copilot/chats/${encodeURIComponent(chatId)}/cards/${encodeURIComponent(cardId)}/decision`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}
