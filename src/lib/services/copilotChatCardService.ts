import type {
  CopilotChatCardRepository,
  CopilotChatCardRow,
  CopilotChatsRepository,
} from '@/lib/repositories';
import {
  ACTION_CARD_SPECS,
  CARD_CONTEXT_LIMIT,
  cardDecisionContext,
  type ActionCardDecision,
  type ActionCardDecisionStatus,
} from '@/lib/chat/actionCards';
import { CopilotChatForbiddenError, CopilotChatNotFoundError } from './copilotChatsService';

/** The longest resolution text stored; the card shows one sentence. */
export const MAX_RESOLUTION_TEXT_CHARS = 1000;
/** The largest decision detail stored, as JSON. */
export const MAX_DECISION_DATA_CHARS = 8000;

/** The body did not describe a valid decision. */
export class InvalidCardDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCardDecisionError';
  }
}

/**
 * The decision was refused but no decision stands on the card either — a
 * state the first-decision-wins write should never leave. Mapped to 409.
 */
export class CardDecisionConflictError extends Error {
  constructor(cardId: string) {
    super(`Card ${cardId} could not be decided`);
    this.name = 'CardDecisionConflictError';
  }
}

export interface DecideCardInput {
  userId: string;
  chatId: string;
  cardId: string;
  toolName?: unknown;
  status?: unknown;
  resolutionText?: unknown;
  data?: unknown;
}

export interface DecideCardResult {
  decision: ActionCardDecision;
  /** The card was already decided (on another device, say); `decision` is that earlier one. */
  alreadyDecided: boolean;
}

export interface CopilotChatCardDeps {
  cards: CopilotChatCardRepository;
  chats: CopilotChatsRepository;
}

/** A stored card's decision as the card renders it, or null while it is pending. */
export function toActionCardDecision(row: CopilotChatCardRow): ActionCardDecision | null {
  if (row.status === 'pending') return null;
  return {
    status: row.status,
    resolutionText: row.resolution_text,
    data: row.decision_data ?? null,
    decidedAt: row.decided_at,
  };
}

function parseStatus(value: unknown): ActionCardDecisionStatus {
  if (value === 'accepted' || value === 'declined') return value;
  throw new InvalidCardDecisionError("status must be 'accepted' or 'declined'");
}

function parseResolutionText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new InvalidCardDecisionError('resolutionText must be a string');
  const text = value.trim();
  if (text.length > MAX_RESOLUTION_TEXT_CHARS) {
    throw new InvalidCardDecisionError(`resolutionText must be at most ${MAX_RESOLUTION_TEXT_CHARS} characters`);
  }
  return text || null;
}

function parseData(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidCardDecisionError('data must be an object');
  }
  if (JSON.stringify(value).length > MAX_DECISION_DATA_CHARS) {
    throw new InvalidCardDecisionError(`data must be at most ${MAX_DECISION_DATA_CHARS} characters as JSON`);
  }
  return value as Record<string, unknown>;
}

/**
 * The action cards in Copilot replies (approvals, options, Workforce
 * hand-offs) and the user's decisions on them: recorded when the user acts,
 * and told to the chat's next turns. Cards are registered by
 * `ChatHistoryService` as their replies are stored.
 */
export class CopilotChatCardService {
  constructor(private readonly deps: CopilotChatCardDeps) {}

  /**
   * Record the user's decision on a card in their own chat. The first
   * decision stands: deciding a card already decided returns that decision,
   * so two devices acting at once agree on one.
   */
  async decide(input: DecideCardInput): Promise<DecideCardResult> {
    const status = parseStatus(input.status);
    const resolutionText = parseResolutionText(input.resolutionText);
    const data = parseData(input.data);
    if (typeof input.toolName !== 'string' || !ACTION_CARD_SPECS[input.toolName]) {
      throw new InvalidCardDecisionError('toolName must name a tool that renders an action card');
    }
    const cardId = input.cardId.trim();
    if (!cardId || cardId.length > 200) throw new InvalidCardDecisionError('cardId is invalid');

    const chat = await this.deps.chats.getById(input.chatId);
    if (!chat) throw new CopilotChatNotFoundError(input.chatId);
    if (chat.user_id !== input.userId) throw new CopilotChatForbiddenError(input.chatId);

    const written = await this.deps.cards.decide({
      chatId: chat.id,
      cardId,
      toolName: input.toolName,
      status,
      resolutionText,
      decisionData: data,
      decidedByUserId: input.userId,
    });
    if (written) {
      return { decision: toActionCardDecision(written)!, alreadyDecided: false };
    }
    // The conflict left the row untouched: it was decided already.
    const existing = await this.deps.cards.findByCardId(chat.id, cardId);
    const decision = existing ? toActionCardDecision(existing) : null;
    if (!decision) {
      console.error('[cards] decision refused with none standing', { chatId: chat.id, cardId, row: existing });
      throw new CardDecisionConflictError(cardId);
    }
    return { decision, alreadyDecided: true };
  }

  /**
   * The system block telling a turn the chat's recent cards and the user's
   * decisions on them, or null when the chat has none.
   */
  async promptContext(chatId: string): Promise<string | null> {
    const rows = await this.deps.cards.listRecent(chatId, CARD_CONTEXT_LIMIT);
    return cardDecisionContext(rows);
  }
}
