import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { copilotChats } from '@/lib/db/schema';
import type { DbClient } from './types';

export type CopilotChatRow = typeof copilotChats.$inferSelect;

export class CopilotChatsRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  /**
   * The user's permanent thread with a bot, created on first open. The partial
   * unique index on `(user_id, workspace_id, bot_id)` turns a concurrent
   * first open's insert into a no-op, so this never makes a second thread. One
   * query when the thread exists. Bot threads always run on the general agent, so sector
   * auto-pinning never applies to them.
   */
  async findOrCreateBotThread(
    userId: string,
    botId: string,
    title: string,
  ): Promise<CopilotChatRow> {
    const existing = await this.findBotThread(userId, botId);
    if (existing) return existing;
    const [inserted] = await this.db
      .insert(copilotChats)
      .values({
        user_id: userId,
        workspace_id: this.workspaceId,
        bot_id: botId,
        agent_key: 'general',
        title,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return inserted;
    // A concurrent open inserted it between the read and the write.
    const raced = await this.findBotThread(userId, botId);
    if (!raced) throw new Error(`Bot thread for bot ${botId} could not be created`);
    return raced;
  }

  /** The user's thread with a bot when one has been opened before: `findOrCreateBotThread` without the create. */
  async findBotThread(userId: string, botId: string): Promise<CopilotChatRow | null> {
    const [row] = await this.db
      .select()
      .from(copilotChats)
      .where(
        and(
          eq(copilotChats.user_id, userId),
          eq(copilotChats.workspace_id, this.workspaceId),
          eq(copilotChats.bot_id, botId),
        ),
      )
      .limit(1);
    return row ?? null;
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

  /**
   * Claim the one-time copy of the thread's checkpoint history into
   * copilot_messages. True for exactly one caller; later calls (and a
   * concurrent one that lost) get false.
   */
  async claimHistoryImport(id: string): Promise<boolean> {
    const rows = await this.db
      .update(copilotChats)
      .set({ history_imported_at: sql`now()` })
      .where(
        and(
          eq(copilotChats.id, id),
          eq(copilotChats.workspace_id, this.workspaceId),
          isNull(copilotChats.history_imported_at),
        ),
      )
      .returning({ id: copilotChats.id });
    return rows.length > 0;
  }

  /** Undo a failed checkpoint import so a later request can retry. */
  async clearHistoryImport(id: string): Promise<void> {
    await this.db
      .update(copilotChats)
      .set({ history_imported_at: null })
      .where(and(eq(copilotChats.id, id), eq(copilotChats.workspace_id, this.workspaceId)));
  }

  /**
   * A reply was stored. `read` also marks the thread read — the user watched
   * an interactive turn; a background reply leaves it unread.
   */
  async stampMessage(id: string, { read }: { read: boolean }): Promise<void> {
    await this.db
      .update(copilotChats)
      .set({
        last_message_at: sql`now()`,
        ...(read ? { last_read_at: sql`now()` } : {}),
      })
      .where(and(eq(copilotChats.id, id), eq(copilotChats.workspace_id, this.workspaceId)));
  }

  async markRead(id: string): Promise<void> {
    await this.db
      .update(copilotChats)
      .set({ last_read_at: sql`now()` })
      .where(and(eq(copilotChats.id, id), eq(copilotChats.workspace_id, this.workspaceId)));
  }

  /** Put the unread dot back: the latest reply counts as unseen again. */
  async markUnread(id: string): Promise<void> {
    await this.db
      .update(copilotChats)
      .set({ last_read_at: null })
      .where(and(eq(copilotChats.id, id), eq(copilotChats.workspace_id, this.workspaceId)));
  }

  /**
   * Take the thread's turn lock for `ttlSeconds`. Atomic: true only when the
   * lock was free (or had expired), so two turns never write one checkpoint
   * thread at once. The TTL frees a lock whose holder died.
   */
  async claimTurn(id: string, ttlSeconds: number): Promise<boolean> {
    const rows = await this.db
      .update(copilotChats)
      .set({ busy_until: sql`now() + make_interval(secs => ${ttlSeconds})` })
      .where(
        and(
          eq(copilotChats.id, id),
          eq(copilotChats.workspace_id, this.workspaceId),
          or(isNull(copilotChats.busy_until), lt(copilotChats.busy_until, sql`now()`)),
        ),
      )
      .returning({ id: copilotChats.id });
    return rows.length > 0;
  }

  /** Whether a turn holds the thread's lock right now. */
  async isTurnRunning(id: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: copilotChats.id })
      .from(copilotChats)
      .where(
        and(
          eq(copilotChats.id, id),
          eq(copilotChats.workspace_id, this.workspaceId),
          gt(copilotChats.busy_until, sql`now()`),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async releaseTurn(id: string): Promise<void> {
    await this.db
      .update(copilotChats)
      .set({ busy_until: null })
      .where(and(eq(copilotChats.id, id), eq(copilotChats.workspace_id, this.workspaceId)));
  }
}
