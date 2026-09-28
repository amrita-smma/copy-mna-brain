import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { copilotChats } from '@/lib/db/schema';
import type { DbClient } from './types';

export type CopilotChatRow = typeof copilotChats.$inferSelect;

export interface ListByUserOptions {
  limit?: number;
  offset?: number;
}

export class CopilotChatsRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  /**
   * One page of the user's chat history, most recently active first.
   *
   * Paged rather than unbounded: a long-lived account accumulates thousands of
   * conversations, and the sidebar only ever shows the top of the list. `limit`
   * is applied by the caller (the service asks for one extra row to detect a
   * further page); omitting it returns everything, which only callers that
   * genuinely need the whole set should do.
   *
   * `last_active_at` alone is not a stable sort key — chats touched in the same
   * transaction share a timestamp and could otherwise swap between pages,
   * duplicating one row and hiding another. `id` breaks the tie deterministically.
   */
  async listByUser(
    userId: string,
    { limit, offset }: ListByUserOptions = {},
  ): Promise<CopilotChatRow[]> {
    const base = this.db
      .select()
      .from(copilotChats)
      .where(
        and(
          eq(copilotChats.user_id, userId),
          isNull(copilotChats.archived_at),
          eq(copilotChats.workspace_id, this.workspaceId),
        ),
      )
      .orderBy(desc(copilotChats.last_active_at), desc(copilotChats.id));
    const paged = limit === undefined ? base : base.limit(limit);
    return offset ? paged.offset(offset) : paged;
  }

  /**
   * Insert a chat. `agentKey` pre-pins the thread's agent (a fork carries its
   * source's); omitted, the thread is unresolved until its first turn.
   */
  async create(userId: string, agentKey?: string): Promise<CopilotChatRow> {
    const [row] = await this.db
      .insert(copilotChats)
      .values({
        user_id: userId,
        workspace_id: this.workspaceId,
        ...(agentKey ? { agent_key: agentKey } : {}),
      })
      .returning();
    return row;
  }

  async getById(id: string): Promise<CopilotChatRow | null> {
    const [row] = await this.db
      .select()
      .from(copilotChats)
      .where(and(eq(copilotChats.id, id), eq(copilotChats.workspace_id, this.workspaceId)))
      .limit(1);
    return row ?? null;
  }

  async touchLastActive(id: string): Promise<void> {
    await this.db
      .update(copilotChats)
      .set({ last_active_at: sql`now()` })
      .where(and(eq(copilotChats.id, id), eq(copilotChats.workspace_id, this.workspaceId)));
  }

  async setTitle(id: string, title: string): Promise<void> {
    await this.db
      .update(copilotChats)
      .set({ title })
      .where(and(eq(copilotChats.id, id), eq(copilotChats.workspace_id, this.workspaceId)));
  }

  /**
   * Pin the thread's effort tier. Written once when Auto routes a new thread,
   * and again when the user picks a tier explicitly. Later turns read it off
   * the row `assertOwnedBy` already loads, so reuse costs no extra query.
   */
  async setEffortTier(id: string, tier: string): Promise<void> {
    await this.db
      .update(copilotChats)
      .set({ effort_tier: tier })
      .where(and(eq(copilotChats.id, id), eq(copilotChats.workspace_id, this.workspaceId)));
  }

  /**
   * Pin the thread's agent, once. The `agent_key IS NULL` guard makes the write
   * first-wins: a second pin (a concurrent first turn, a retry) never
   * overwrites the agent the thread already runs on. Returns the key the
   * thread is pinned to after the call — the stored one when this write lost —
   * or null when the chat doesn't exist in this workspace.
   */
  async pinAgentKey(id: string, agentKey: string): Promise<string | null> {
    const [pinned] = await this.db
      .update(copilotChats)
      .set({ agent_key: agentKey })
      .where(
        and(
          eq(copilotChats.id, id),
          eq(copilotChats.workspace_id, this.workspaceId),
          isNull(copilotChats.agent_key),
        ),
      )
      .returning({ agent_key: copilotChats.agent_key });
    if (pinned) return pinned.agent_key;
    const [existing] = await this.db
      .select({ agent_key: copilotChats.agent_key })
      .from(copilotChats)
      .where(and(eq(copilotChats.id, id), eq(copilotChats.workspace_id, this.workspaceId)))
      .limit(1);
    return existing?.agent_key ?? null;
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
      .where(and(eq(copilotChats.id, id), eq(copilotChats.workspace_id, this.workspaceId)));
  }

  /**
   * Find the most recently active, non-archived chat whose first user message
   * matches the given hash. Scoped to this workspace only — a cached answer
   * may reference this workspace's proprietary company/thesis data, so it
   * must never be reused across workspaces even though it's not scoped to a
   * single user. Returns null when there's no match.
   *
   * Also scoped to the agent the new chat would run on: an answer a sector
   * agent produced must never be offered to a general-CoPilot chat, or the
   * reverse.
   */
  async findLatestFirstMessageMatch(
    hash: string,
    agentKey: string,
  ): Promise<CopilotChatRow | null> {
    const [row] = await this.db
      .select()
      .from(copilotChats)
      .where(
        and(
          eq(copilotChats.first_user_message_hash, hash),
          eq(copilotChats.agent_key, agentKey),
          isNull(copilotChats.archived_at),
          eq(copilotChats.workspace_id, this.workspaceId),
        ),
      )
      .orderBy(desc(copilotChats.last_active_at))
      .limit(1);
    return row ?? null;
  }
}
