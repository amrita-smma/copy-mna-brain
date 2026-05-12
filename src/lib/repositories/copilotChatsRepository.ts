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
}
