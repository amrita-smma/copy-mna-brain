import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { userTasks } from '@/lib/db/schema';
import type { DbClient, Tables } from './types';

export type UserTaskRow = Tables<'user_tasks'>;

export interface UserTaskPatch {
  title?: string;
  remind_at?: string | null;
  /** Set by the service when `remind_at` moves, so the new time fires again. */
  reminder_sent_at?: string | null;
  completed_at?: string | null;
}

/**
 * Personal to-dos. Every read and write is scoped to the workspace AND the
 * owning user — a task id belonging to someone else matches nothing.
 */
export class UserTaskRepository {
  constructor(
    private readonly db: DbClient,
    private readonly workspaceId: string,
  ) {}

  private owned(userId: string) {
    return and(eq(userTasks.workspace_id, this.workspaceId), eq(userTasks.user_id, userId));
  }

  /**
   * Open tasks oldest-first (the order they were added, like a checklist),
   * followed by completed tasks most-recently-completed first. Both slices
   * are capped so the read stays bounded however long the list grows; the
   * open cap keeps the NEWEST tasks, so one just added never falls off.
   */
  async listForUser(
    userId: string,
    { openLimit, completedLimit }: { openLimit: number; completedLimit: number },
  ): Promise<UserTaskRow[]> {
    const [open, done] = await Promise.all([
      this.db
        .select()
        .from(userTasks)
        .where(and(this.owned(userId), isNull(userTasks.completed_at)))
        .orderBy(desc(userTasks.created_at))
        .limit(openLimit),
      this.db
        .select()
        .from(userTasks)
        .where(and(this.owned(userId), isNotNull(userTasks.completed_at)))
        .orderBy(desc(userTasks.completed_at))
        .limit(completedLimit),
    ]);
    return [...open.reverse(), ...done];
  }

  async create(userId: string, data: { title: string; remind_at: string | null }): Promise<UserTaskRow> {
    const [row] = await this.db
      .insert(userTasks)
      .values({ workspace_id: this.workspaceId, user_id: userId, ...data })
      .returning();
    return row;
  }

  /** Returns `null` when no task with that id belongs to the user. */
  async update(id: string, userId: string, patch: UserTaskPatch): Promise<UserTaskRow | null> {
    const [row] = await this.db
      .update(userTasks)
      .set({ ...patch, updated_at: sql`now()` })
      .where(and(eq(userTasks.id, id), this.owned(userId)))
      .returning();
    return row ?? null;
  }

  /** Returns whether a task was removed. */
  async delete(id: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .delete(userTasks)
      .where(and(eq(userTasks.id, id), this.owned(userId)))
      .returning({ id: userTasks.id });
    return rows.length > 0;
  }

  /**
   * Atomically claim open tasks whose reminder has passed and was not sent:
   * one `UPDATE … WHERE reminder_sent_at IS NULL … RETURNING` stamps them, so
   * two overlapping sweeps can never both claim (and email) the same task.
   */
  async claimDueReminders(now: string, limit: number): Promise<UserTaskRow[]> {
    const due = this.db
      .select({ id: userTasks.id })
      .from(userTasks)
      .where(
        and(
          eq(userTasks.workspace_id, this.workspaceId),
          isNull(userTasks.completed_at),
          isNull(userTasks.reminder_sent_at),
          isNotNull(userTasks.remind_at),
          lte(userTasks.remind_at, now),
        ),
      )
      .orderBy(asc(userTasks.remind_at))
      .limit(limit);
    return this.db
      .update(userTasks)
      .set({ reminder_sent_at: now })
      .where(
        and(
          eq(userTasks.workspace_id, this.workspaceId),
          inArray(userTasks.id, due),
          isNull(userTasks.reminder_sent_at),
        ),
      )
      .returning();
  }

  /**
   * Give claimed reminders back (their send failed) so the next sweep retries
   * them. Only clears the stamp this sweep set, in one set-based update.
   */
  async releaseReminders(ids: string[], claimedAt: string): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(userTasks)
      .set({ reminder_sent_at: null })
      .where(
        and(
          eq(userTasks.workspace_id, this.workspaceId),
          inArray(userTasks.id, ids),
          eq(userTasks.reminder_sent_at, claimedAt),
        ),
      );
  }
}
