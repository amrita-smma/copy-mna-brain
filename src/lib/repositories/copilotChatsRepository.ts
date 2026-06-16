import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { copilotChats } from '@/lib/db/schema';
import type { DbClient } from './types';

export type CopilotChatRow = typeof copilotChats.$inferSelect;

export class CopilotChatsRepository {
  constructor(private readonly db: DbClient) {}

  async listByUser(userId: string): Promise<CopilotChatRow[]> {
    return this.db
      .select()
      .from(copilotChats)
      .where(
        and(eq(copilotChats.user_id, userId), isNull(copilotChats.archived_at)),
      )
      .orderBy(desc(copilotChats.last_active_at));
  }

  async create(userId: string): Promise<CopilotChatRow> {
    const [row] = await this.db
      .insert(copilotChats)
      .values({ user_id: userId })
      .returning();
    return row;
  }

  async getById(id: string): Promise<CopilotChatRow | null> {
    const [row] = await this.db
      .select()
      .from(copilotChats)
      .where(eq(copilotChats.id, id))
      .limit(1);
    return row ?? null;
  }

  async touchLastActive(id: string): Promise<void> {
    await this.db
      .update(copilotChats)
      .set({ last_active_at: sql`now()` })
      .where(eq(copilotChats.id, id));
  }

  async setTitle(id: string, title: string): Promise<void> {
    await this.db
      .update(copilotChats)
      .set({ title })
      .where(eq(copilotChats.id, id));
  }

  /** Persist the chat's first user message and the hash used for cache lookups. */
  async recordFirstMessage(
    id: string,
    message: string,
    hash: string,
  ): Promise<void> {
    await this.db
      .update(copilotChats)
      .set({ first_user_message: message, first_user_message_hash: hash })
      .where(eq(copilotChats.id, id));
  }

  /**
   * Find the most recently active, non-archived chat whose first user message
   * matches the given hash. Global (not scoped to a user) so any prior answer
   * can be reused. Returns null when there's no match.
   */
  async findLatestFirstMessageMatch(
    hash: string,
  ): Promise<CopilotChatRow | null> {
    const [row] = await this.db
      .select()
      .from(copilotChats)
      .where(
        and(
          eq(copilotChats.first_user_message_hash, hash),
          isNull(copilotChats.archived_at),
        ),
      )
      .orderBy(desc(copilotChats.last_active_at))
      .limit(1);
    return row ?? null;
  }
}
