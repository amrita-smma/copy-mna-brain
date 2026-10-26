import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { copilotResponseFeedback } from '@/lib/db/schema';
import type { DbClient } from './types';

export type CopilotResponseFeedbackRow = typeof copilotResponseFeedback.$inferSelect;

/** One vote as the feedback service writes it; the turn facts come from the question row. */
export interface UpsertCopilotResponseFeedback {
  userId: string;
  chatId: string;
  /** The turn's question row (copilot_messages, role 'user'). */
  messageId: string;
  botId: string | null;
  traceId: string | null;
  model: string | null;
  effortTier: string | null;
  rating: number | null;
  reasons: string[];
  comment: string | null;
}

/** Workspace-scoped data access for feedback on Copilot replies (MB-693). */
export class CopilotResponseFeedbackRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  /**
   * Insert the user's vote on a turn, or replace the one they already left.
   * Only the vote changes on a conflict: the turn facts were copied from the
   * question row on the first write and do not move.
   */
  async upsert(input: UpsertCopilotResponseFeedback): Promise<CopilotResponseFeedbackRow> {
    const [row] = await this.db
      .insert(copilotResponseFeedback)
      .values({
        workspace_id: this.workspaceId,
        user_id: input.userId,
        chat_id: input.chatId,
        message_id: input.messageId,
        bot_id: input.botId,
        trace_id: input.traceId,
        model: input.model,
        effort_tier: input.effortTier,
        rating: input.rating,
        reasons: input.reasons,
        comment: input.comment,
      })
      .onConflictDoUpdate({
        target: [copilotResponseFeedback.user_id, copilotResponseFeedback.message_id],
        set: {
          rating: input.rating,
          reasons: input.reasons,
          comment: input.comment,
          updated_at: sql`now()`,
        },
      })
      .returning();
    return row;
  }

  /** The user's votes on the given question rows, grouped by `message_id`. */
  async findByMessageIds(userId: string, messageIds: string[]): Promise<CopilotResponseFeedbackRow[]> {
    if (messageIds.length === 0) return [];
    return this.db
      .select()
      .from(copilotResponseFeedback)
      .where(
        and(
          eq(copilotResponseFeedback.workspace_id, this.workspaceId),
          eq(copilotResponseFeedback.user_id, userId),
          inArray(copilotResponseFeedback.message_id, messageIds),
        ),
      )
      .orderBy(asc(copilotResponseFeedback.message_id));
  }
}
