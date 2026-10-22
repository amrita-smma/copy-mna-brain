import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { botRequests } from '@/lib/db/schema';
import type { DbClient } from './types';

export type BotRequestRow = typeof botRequests.$inferSelect;
export type BotRequestStatus = BotRequestRow['status'];

/** One request, as `BotRequestService.open` writes it. */
export interface NewBotRequest {
  group_id: string;
  user_id: string;
  from_bot_id: string;
  from_bot_name: string;
  from_chat_id: string;
  to_bot_id: string;
  to_bot_name: string;
  ask: string;
}

/** What closing a request tells the caller: the row, and the whole group once it is the last. */
export interface BotRequestClose {
  /** The row this call closed; null when it was already closed (idempotent). */
  closed: BotRequestRow | null;
  /** Every request of the group, oldest first, when this close completed it; else null. */
  group: BotRequestRow[] | null;
}

/**
 * Requests one bot made to another by @mention, scoped to a workspace. The
 * rows exist so the asking bot always hears back: see
 * `src/lib/services/botRequestService.ts`.
 */
export class BotRequestRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  async createMany(rows: NewBotRequest[]): Promise<BotRequestRow[]> {
    if (rows.length === 0) return [];
    return this.db
      .insert(botRequests)
      .values(rows.map((r) => ({ ...r, workspace_id: this.workspaceId })))
      .returning();
  }

  /**
   * Close a pending request and say whether it was the group's last. Runs
   * under the group's advisory lock, so two bots answering at once are
   * serialized and exactly one of them sees the group complete — without
   * the lock each would still see the other's row pending (READ COMMITTED)
   * and the group would never close. A request already closed is left as it
   * is: `runJob`'s timeout can mark a job timed out while its work still
   * finishes, so a close must be safe to repeat.
   */
  async close(
    id: string,
    outcome: { status: Exclude<BotRequestStatus, 'pending'>; answer: string | null },
  ): Promise<BotRequestClose> {
    return this.db.transaction(async (tx) => {
      const [pending] = await tx
        .select({ group_id: botRequests.group_id })
        .from(botRequests)
        .where(and(eq(botRequests.id, id), eq(botRequests.workspace_id, this.workspaceId)))
        .limit(1);
      if (!pending) return { closed: null, group: null };
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${pending.group_id}))`);
      const [closed] = await tx
        .update(botRequests)
        .set({ status: outcome.status, answer: outcome.answer, closed_at: sql`now()` })
        .where(
          and(
            eq(botRequests.id, id),
            eq(botRequests.workspace_id, this.workspaceId),
            eq(botRequests.status, 'pending'),
          ),
        )
        .returning();
      if (!closed) return { closed: null, group: null };
      const [{ open }] = await tx
        .select({ open: sql<number>`count(*)::int` })
        .from(botRequests)
        .where(
          and(
            eq(botRequests.group_id, closed.group_id),
            eq(botRequests.workspace_id, this.workspaceId),
            eq(botRequests.status, 'pending'),
          ),
        );
      if (open > 0) return { closed, group: null };
      const group = await tx
        .select()
        .from(botRequests)
        .where(and(eq(botRequests.group_id, closed.group_id), eq(botRequests.workspace_id, this.workspaceId)))
        .orderBy(asc(botRequests.created_at), asc(botRequests.id));
      return { closed, group };
    });
  }

  /** Requests still open after `olderThanSeconds`, oldest first; for the sweep. */
  async findStale(olderThanSeconds: number, limit: number): Promise<BotRequestRow[]> {
    return this.db
      .select()
      .from(botRequests)
      .where(
        and(
          eq(botRequests.workspace_id, this.workspaceId),
          eq(botRequests.status, 'pending'),
          lt(botRequests.created_at, sql`now() - make_interval(secs => ${olderThanSeconds})`),
        ),
      )
      .orderBy(asc(botRequests.created_at))
      .limit(limit);
  }
}

/**
 * The stale requests of every workspace, for the dispatch cron, which runs
 * with no workspace: it groups these by workspace and sweeps each through
 * its own container. Deliberately the only cross-workspace read here.
 */
export async function findStaleBotRequests(
  db: DbClient,
  olderThanSeconds: number,
  limit: number,
): Promise<{ id: string; workspace_id: string }[]> {
  return db
    .select({ id: botRequests.id, workspace_id: botRequests.workspace_id })
    .from(botRequests)
    .where(
      and(
        eq(botRequests.status, 'pending'),
        lt(botRequests.created_at, sql`now() - make_interval(secs => ${olderThanSeconds})`),
      ),
    )
    .orderBy(asc(botRequests.created_at))
    .limit(limit);
}
