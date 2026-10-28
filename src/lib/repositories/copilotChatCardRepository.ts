import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { copilotChatCards } from '@/lib/db/schema';
import type { ActionCardDecisionStatus } from '@/lib/chat/actionCards';
import type { DbClient } from './types';

export type CopilotChatCardRow = typeof copilotChatCards.$inferSelect;

/** A card a stored reply offered, as the history writer registers it. */
export interface RegisterCopilotChatCard {
  chatId: string;
  messageId: string | null;
  cardId: string;
  toolName: string;
  summary: string;
}

/** The user's decision on a card. */
export interface DecideCopilotChatCard {
  chatId: string;
  cardId: string;
  toolName: string;
  status: ActionCardDecisionStatus;
  resolutionText: string | null;
  decisionData: Record<string, unknown> | null;
  decidedByUserId: string;
}

/** Workspace-scoped data access for the action cards in Copilot replies and their decisions. */
export class CopilotChatCardRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  /**
   * Register the cards a stored reply offered, as pending. A card decided
   * before its reply was stored (mid-stream) already has a row: only the
   * reply's facts are filled in, never its decision.
   */
  async registerMany(cards: RegisterCopilotChatCard[]): Promise<void> {
    if (cards.length === 0) return;
    await this.db
      .insert(copilotChatCards)
      .values(
        cards.map((c) => ({
          workspace_id: this.workspaceId,
          chat_id: c.chatId,
          message_id: c.messageId,
          card_id: c.cardId,
          tool_name: c.toolName,
          summary: c.summary,
        })),
      )
      .onConflictDoUpdate({
        target: [copilotChatCards.chat_id, copilotChatCards.card_id],
        set: {
          message_id: sql`coalesce(excluded.message_id, ${copilotChatCards.message_id})`,
          summary: sql`excluded.summary`,
          updated_at: sql`now()`,
        },
      });
  }

  /**
   * Record the decision on a pending card, creating the row when the card was
   * never registered (decided mid-stream, or offered before cards were
   * stored). First decision wins: a card already decided is left as it is,
   * and null comes back.
   */
  async decide(input: DecideCopilotChatCard): Promise<CopilotChatCardRow | null> {
    const [row] = await this.db
      .insert(copilotChatCards)
      .values({
        workspace_id: this.workspaceId,
        chat_id: input.chatId,
        card_id: input.cardId,
        tool_name: input.toolName,
        status: input.status,
        resolution_text: input.resolutionText,
        decision_data: input.decisionData,
        decided_by_user_id: input.decidedByUserId,
        decided_at: sql`now()`,
      })
      .onConflictDoUpdate({
        target: [copilotChatCards.chat_id, copilotChatCards.card_id],
        set: {
          status: input.status,
          resolution_text: input.resolutionText,
          decision_data: input.decisionData,
          decided_by_user_id: input.decidedByUserId,
          decided_at: sql`now()`,
          updated_at: sql`now()`,
        },
        setWhere: eq(copilotChatCards.status, 'pending'),
      })
      .returning();
    return row ?? null;
  }

  /** One card of a chat, or null. */
  async findByCardId(chatId: string, cardId: string): Promise<CopilotChatCardRow | null> {
    const [row] = await this.db
      .select()
      .from(copilotChatCards)
      .where(
        and(
          eq(copilotChatCards.workspace_id, this.workspaceId),
          eq(copilotChatCards.chat_id, chatId),
          eq(copilotChatCards.card_id, cardId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** A chat's cards with the given ids (one history page's), ordered by card id. */
  async findByCardIds(chatId: string, cardIds: string[]): Promise<CopilotChatCardRow[]> {
    if (cardIds.length === 0) return [];
    return this.db
      .select()
      .from(copilotChatCards)
      .where(
        and(
          eq(copilotChatCards.workspace_id, this.workspaceId),
          eq(copilotChatCards.chat_id, chatId),
          inArray(copilotChatCards.card_id, cardIds),
        ),
      )
      .orderBy(asc(copilotChatCards.card_id));
  }

  /**
   * A chat's most recent cards that a stored reply offered, newest first. A
   * row with no reply (decided mid-stream and the turn never stored, or a
   * card id no reply carried) is left out: only cards the agent really
   * offered are reported back to it.
   */
  async listRecent(chatId: string, limit: number): Promise<CopilotChatCardRow[]> {
    return this.db
      .select()
      .from(copilotChatCards)
      .where(
        and(
          eq(copilotChatCards.workspace_id, this.workspaceId),
          eq(copilotChatCards.chat_id, chatId),
          isNotNull(copilotChatCards.message_id),
        ),
      )
      .orderBy(desc(copilotChatCards.created_at))
      .limit(limit);
  }
}
