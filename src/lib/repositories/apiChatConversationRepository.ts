import { and, desc, eq, sql } from 'drizzle-orm';
import { apiChatConversations } from '@/lib/db/schema';
import type { DbClient } from './types';

export type ApiChatConversationRow = typeof apiChatConversations.$inferSelect;

export class ApiChatConversationRepository {
  constructor(private readonly db: DbClient) {}

  async listByApiKey(apiKeyId: string): Promise<ApiChatConversationRow[]> {
    return this.db
      .select()
      .from(apiChatConversations)
      .where(eq(apiChatConversations.api_key_id, apiKeyId))
      .orderBy(desc(apiChatConversations.last_active_at));
  }

  async create(apiKeyId: string): Promise<ApiChatConversationRow> {
    const [row] = await this.db
      .insert(apiChatConversations)
      .values({ api_key_id: apiKeyId })
      .returning();
    return row;
  }

  async getByIdForApiKey(
    id: string,
    apiKeyId: string,
  ): Promise<ApiChatConversationRow | null> {
    const [row] = await this.db
      .select()
      .from(apiChatConversations)
      .where(
        and(
          eq(apiChatConversations.id, id),
          eq(apiChatConversations.api_key_id, apiKeyId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async touchLastActive(id: string): Promise<void> {
    await this.db
      .update(apiChatConversations)
      .set({ last_active_at: sql`now()` })
      .where(eq(apiChatConversations.id, id));
  }

  async setTitle(id: string, title: string): Promise<void> {
    await this.db
      .update(apiChatConversations)
      .set({ title })
      .where(eq(apiChatConversations.id, id));
  }
}
