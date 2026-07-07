import { and, desc, eq, sql } from 'drizzle-orm';
import { apiChatConversations } from '@/lib/db/schema';
import type { DbClient } from './types';

export type ApiChatConversationRow = typeof apiChatConversations.$inferSelect;

export class ApiChatConversationRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  async listByApiKey(apiKeyId: string): Promise<ApiChatConversationRow[]> {
    return this.db
      .select()
      .from(apiChatConversations)
      .where(
        and(
          eq(apiChatConversations.api_key_id, apiKeyId),
          eq(apiChatConversations.workspace_id, this.workspaceId),
        ),
      )
      .orderBy(desc(apiChatConversations.last_active_at));
  }

  async create(apiKeyId: string): Promise<ApiChatConversationRow> {
    const [row] = await this.db
      .insert(apiChatConversations)
      .values({ api_key_id: apiKeyId, workspace_id: this.workspaceId })
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
          eq(apiChatConversations.workspace_id, this.workspaceId),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async touchLastActive(id: string): Promise<void> {
    await this.db
      .update(apiChatConversations)
      .set({ last_active_at: sql`now()` })
      .where(and(eq(apiChatConversations.id, id), eq(apiChatConversations.workspace_id, this.workspaceId)));
  }

  async setTitle(id: string, title: string): Promise<void> {
    await this.db
      .update(apiChatConversations)
      .set({ title })
      .where(and(eq(apiChatConversations.id, id), eq(apiChatConversations.workspace_id, this.workspaceId)));
  }
}
