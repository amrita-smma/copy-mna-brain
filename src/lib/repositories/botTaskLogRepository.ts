import { and, desc, eq, isNotNull, or, sql } from 'drizzle-orm';
import { botTaskLogs, routines } from '@/lib/db/schema';
import type { DbClient } from './types';

export type BotTaskLogRow = typeof botTaskLogs.$inferSelect;
export type BotTaskSource = BotTaskLogRow['source'];

export interface NewBotTaskLog {
  bot_id: string;
  user_id: string;
  chat_id: string | null;
  routine_id: string | null;
  source: BotTaskSource;
  summary: string;
}

/** A task log row with its routine's title, for the bot's Task log tab. */
export type BotTaskLogListRow = BotTaskLogRow & { routine_title: string | null };

/** Where the next (older) page starts: the last row's `created_at` and `id`. */
export interface BotTaskLogCursor {
  createdAt: string;
  id: string;
}

export class BotTaskLogRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  async insert(entry: NewBotTaskLog): Promise<BotTaskLogRow> {
    const [row] = await this.db
      .insert(botTaskLogs)
      .values({ ...entry, workspace_id: this.workspaceId })
      .returning();
    return row;
  }

  /**
   * The bot's tasks a user may see, newest first: those from the user's own
   * chats, and every routine run (a shared bot's routines are shared, and a
   * private bot is only its owner's anyway). Other people's chats stay theirs.
   * With `ownOnly`, just the user's own rows (Brain Bot: each user's routines
   * are their own). One page of `limit`; `hasMore` when an older page exists.
   */
  async listForUser(
    botId: string,
    userId: string,
    opts: { before?: BotTaskLogCursor; limit: number; ownOnly?: boolean },
  ): Promise<{ rows: BotTaskLogListRow[]; hasMore: boolean }> {
    const conditions = [
      eq(botTaskLogs.workspace_id, this.workspaceId),
      eq(botTaskLogs.bot_id, botId),
      opts.ownOnly
        ? eq(botTaskLogs.user_id, userId)
        : or(eq(botTaskLogs.user_id, userId), isNotNull(botTaskLogs.routine_id)),
    ];
    if (opts.before) {
      conditions.push(
        sql`(${botTaskLogs.created_at}, ${botTaskLogs.id}) < (${opts.before.createdAt}::timestamptz, ${opts.before.id}::uuid)`,
      );
    }
    const rows = await this.db
      .select({
        id: botTaskLogs.id,
        workspace_id: botTaskLogs.workspace_id,
        bot_id: botTaskLogs.bot_id,
        user_id: botTaskLogs.user_id,
        chat_id: botTaskLogs.chat_id,
        routine_id: botTaskLogs.routine_id,
        source: botTaskLogs.source,
        summary: botTaskLogs.summary,
        created_at: botTaskLogs.created_at,
        routine_title: routines.title,
      })
      .from(botTaskLogs)
      .leftJoin(routines, eq(routines.id, botTaskLogs.routine_id))
      .where(and(...conditions))
      .orderBy(desc(botTaskLogs.created_at), desc(botTaskLogs.id))
      .limit(opts.limit + 1);
    return { rows: rows.slice(0, opts.limit), hasMore: rows.length > opts.limit };
  }
}
