import { and, eq, sql } from 'drizzle-orm';
import { botUserMemories } from '@/lib/db/schema';
import type { BotMemoryNote } from '@/lib/bots/memoryTypes';
import type { DbClient } from './types';

export type BotUserMemoryRow = typeof botUserMemories.$inferSelect;

/**
 * What one bot remembers about one user (`bot_user_memories`): one row per
 * user per bot holding the notes as a jsonb array, scoped to a workspace. The
 * service owns what goes in the array; this reads it, and rewrites it under
 * a row lock so two writers (the bot's tool and the Memory tab, or two tabs)
 * never lose each other's notes.
 */
export class BotMemoryRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  private key(botId: string, userId: string) {
    return and(
      eq(botUserMemories.workspace_id, this.workspaceId),
      eq(botUserMemories.bot_id, botId),
      eq(botUserMemories.user_id, userId),
    );
  }

  async find(botId: string, userId: string): Promise<BotUserMemoryRow | null> {
    const rows = await this.db.select().from(botUserMemories).where(this.key(botId, userId)).limit(1);
    return rows[0] ?? null;
  }

  /**
   * Rewrite the user's notes for the bot from what is there right now:
   * `change` gets the current list under `SELECT … FOR UPDATE` and returns the
   * new one, or null to leave it. The row is created (empty) first, so the
   * lock has something to hold. Returns the list as it stands afterwards.
   */
  async update(
    botId: string,
    userId: string,
    change: (current: BotMemoryNote[]) => BotMemoryNote[] | null,
  ): Promise<BotMemoryNote[]> {
    return this.db.transaction(async (tx) => {
      await tx
        .insert(botUserMemories)
        .values({ workspace_id: this.workspaceId, bot_id: botId, user_id: userId, notes: [] })
        .onConflictDoNothing({ target: [botUserMemories.bot_id, botUserMemories.user_id] });
      const [row] = await tx.select().from(botUserMemories).where(this.key(botId, userId)).for('update');
      const current = row?.notes ?? [];
      const next = change(current);
      if (next === null || !row) return current;
      await tx
        .update(botUserMemories)
        .set({ notes: next, updated_at: sql`now()` })
        .where(eq(botUserMemories.id, row.id));
      return next;
    });
  }
}
