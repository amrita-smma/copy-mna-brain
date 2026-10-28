'use client';

import { createContext, useContext } from 'react';
import type { ActionCardDecision } from '@/lib/chat/actionCards';

/**
 * The stored decisions on the action cards of one reply, by card id — the
 * reply's `metadata.cardDecisions` from the history page. Provided by
 * ChatMessageBubble around its cards; read by `useApprovalResolution`.
 */
const ActionCardDecisionsContext = createContext<Readonly<Record<string, ActionCardDecision>> | null>(null);

export const ActionCardDecisionsProvider = ActionCardDecisionsContext.Provider;

/** The stored decision on a card, or null while it is pending (or unknown). */
export function useActionCardDecision(cardId: string | null | undefined): ActionCardDecision | null {
  const decisions = useContext(ActionCardDecisionsContext);
  if (!cardId || !decisions) return null;
  return decisions[cardId] ?? null;
}
