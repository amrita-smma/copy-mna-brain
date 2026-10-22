import { and, asc, desc, eq, getTableColumns, isNull, or, sql } from 'drizzle-orm';
import { botOrders, bots, copilotChats } from '@/lib/db/schema';
import type { DbClient } from './types';

export type BotRow = typeof bots.$inferSelect;
export type CreateBotInput = Omit<typeof bots.$inferInsert, 'workspace_id' | 'id'>;
export type BotPatch = Partial<
  Pick<
    typeof bots.$inferInsert,
    'name' | 'persona_md' | 'base_flavor' | 'avatar' | 'visibility'
  >
>;

/** A visible bot plus the state of the user's own thread with it, and whether they pinned it. */
export type VisibleBotRow = BotRow & {
  /** The user's thread with the bot; null until they first open it. */
  chat_id: string | null;
  /** The thread has a reply the user has not read. */
  unread: boolean;
  /** The thread's turn lock is held: the bot is answering right now. */
  busy: boolean;
  /** The user pinned the bot (it is in their `bot_orders` list). */
  pinned: boolean;
  /** The thread's latest stored reply; null when they never chatted. */
  last_activity_at: string | null;
  /** The thread's latest message with text (capped), for list previews. */
  last_message: BotLastMessage | null;
};

/** The start of a thread's latest message, as the bot list previews it. */
export interface BotLastMessage {
  role: 'user' | 'assistant';
  text: string;
}

/** How much of the latest message the list reads; the UI truncates further. */
export const BOT_PREVIEW_MAX_CHARS = 280;

/** Copilot bots (RFC 02), scoped to one workspace. */
export class BotRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  private live(id: string) {
    return and(eq(bots.workspace_id, this.workspaceId), eq(bots.id, id), isNull(bots.archived_at));
  }

  /**
   * Live bots the user can see: every workspace-visible bot plus the user's own
   * private ones, with the state of the user's thread with each. Order: the
   * user's pinned bots first, in their order (`bot_orders`); then the rest by
   * newest activity (the latest stored reply in the user's thread with it);
   * then the default bot, then by name. One query: the thread join hits the
   * `(user_id, workspace_id, bot_id)` unique index and the pin join the
   * `bot_orders` primary key.
   */
  async listVisible(userId: string): Promise<VisibleBotRow[]> {
    return this.db
      .select({
        ...getTableColumns(bots),
        chat_id: copilotChats.id,
        unread: sql<boolean>`coalesce(${copilotChats.last_message_at} > coalesce(${copilotChats.last_read_at}, 'epoch'::timestamptz), false)`,
        // The thread's turn lock: an interactive turn, or a background reply to another bot.
        busy: sql<boolean>`coalesce(${copilotChats.busy_until} > now(), false)`,
        pinned: sql<boolean>`(array_position(${botOrders.bot_ids}, ${bots.id}) is not null)`,
        last_activity_at: copilotChats.last_message_at,
        // Correlated on the thread, newest first: walks idx_copilot_messages_chat_seq
        // and stops at the first message with text (tool-only turns have none).
        last_message: sql<BotLastMessage | null>`(
          select json_build_object('role', m.role, 'text', left(m.text, ${BOT_PREVIEW_MAX_CHARS}))
          from copilot_messages m
          where m.chat_id = ${copilotChats.id} and m.text <> ''
          order by m.seq desc
          limit 1
        )`,
      })
      .from(bots)
      .leftJoin(
        copilotChats,
        and(
          eq(copilotChats.bot_id, bots.id),
          eq(copilotChats.user_id, userId),
          eq(copilotChats.workspace_id, this.workspaceId),
        ),
      )
      .leftJoin(
        botOrders,
        and(eq(botOrders.user_id, userId), eq(botOrders.workspace_id, this.workspaceId)),
      )
      .where(
        and(
          eq(bots.workspace_id, this.workspaceId),
          isNull(bots.archived_at),
          or(eq(bots.visibility, 'workspace'), eq(bots.owner_user_id, userId)),
        ),
      )
      // Brain Bot (the default bot) always leads, then the user's pins.
      .orderBy(
        desc(bots.is_default),
        sql`array_position(${botOrders.bot_ids}, ${bots.id}) asc nulls last`,
        sql`${copilotChats.last_message_at} desc nulls last`,
        asc(bots.name),
        asc(bots.id),
      );
  }

  /** Save the user's pinned bots, in order, replacing any earlier list. */
  async savePinned(userId: string, botIds: string[]): Promise<void> {
    const updatedAt = new Date().toISOString();
    await this.db
      .insert(botOrders)
      .values({ user_id: userId, workspace_id: this.workspaceId, bot_ids: botIds, updated_at: updatedAt })
      .onConflictDoUpdate({
        target: [botOrders.user_id, botOrders.workspace_id],
        set: { bot_ids: botIds, updated_at: updatedAt },
      });
  }

  /** A live bot by id, regardless of visibility (the service checks that). */
  async findById(id: string): Promise<BotRow | null> {
    const [row] = await this.db.select().from(bots).where(this.live(id)).limit(1);
    return row ?? null;
  }

  async findDefault(): Promise<BotRow | null> {
    const [row] = await this.db
      .select()
      .from(bots)
      .where(and(eq(bots.workspace_id, this.workspaceId), eq(bots.is_default, true), isNull(bots.archived_at)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Insert the workspace's default bot if it has none. The partial unique index
   * on `(workspace_id) WHERE is_default` makes a concurrent second insert a
   * no-op. Returns the default bot either way.
   */
  async ensureDefault(input: CreateBotInput): Promise<BotRow | null> {
    await this.db
      .insert(bots)
      .values({ ...input, workspace_id: this.workspaceId, is_default: true, owner_user_id: null })
      .onConflictDoNothing();
    return this.findDefault();
  }

  async create(input: CreateBotInput): Promise<BotRow> {
    const [row] = await this.db
      .insert(bots)
      .values({ ...input, workspace_id: this.workspaceId })
      .returning();
    return row;
  }

  async update(id: string, patch: BotPatch): Promise<BotRow | null> {
    const [row] = await this.db.update(bots).set(patch).where(this.live(id)).returning();
    return row ?? null;
  }

  /** Soft delete. The default bot is never archived. */
  async archive(id: string): Promise<boolean> {
    const rows = await this.db
      .update(bots)
      .set({ archived_at: new Date().toISOString() })
      .where(and(this.live(id), eq(bots.is_default, false)))
      .returning({ id: bots.id });
    return rows.length > 0;
  }
}
