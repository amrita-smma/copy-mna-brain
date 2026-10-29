import { publishLiveEvent } from '@/lib/server/liveEvents';
import { LIVE_TOPICS } from '@/lib/live/topics';
import type {
  UserRepository,
  UserTaskPatch,
  UserTaskRepository,
  UserTaskRow,
  WorkspaceRepository,
} from '@/lib/repositories';
import { enqueueSendEmail } from '@/lib/queue';
import type { SendEmailPayload } from '@/lib/jobs/handlers/sendEmail';

type EnqueueFn = (payload: SendEmailPayload) => Promise<{ messageId: string | null }>;

/** Longest title accepted — a to-do line, not a document. */
export const USER_TASK_TITLE_MAX = 500;
/** Open tasks returned with the list — a safety cap, not a page size. */
const OPEN_LIMIT = 500;
/** Completed tasks returned with the list; older ones stay in the DB unseen. */
const COMPLETED_LIMIT = 20;
/** Reminders sent per workspace per sweep; the rest roll into the next run. */
const REMINDER_BATCH = 200;

export interface UserTask {
  id: string;
  title: string;
  remindAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface UserTaskInput {
  title: string;
  remindAt?: string | null;
}

export interface UserTaskUpdate {
  title?: string;
  remindAt?: string | null;
  completed?: boolean;
}

export interface TaskReminderResult {
  /** Tasks whose reminder was handled (emailed, or skipped for lack of an address). */
  reminded: number;
  /** Emails enqueued. */
  notified: number;
}

/** A title or reminder the user sent that cannot be stored. */
export class UserTaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserTaskValidationError';
  }
}

function resolveAppUrl(): string {
  return (
    process.env.APP_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXTAUTH_URL ??
    'http://localhost:3000'
  ).replace(/\/+$/, '');
}

function toDto(row: UserTaskRow): UserTask {
  return {
    id: row.id,
    title: row.title,
    remindAt: row.remind_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

function normalizeTitle(raw: unknown): string {
  if (typeof raw !== 'string') throw new UserTaskValidationError('title must be a string');
  const title = raw.trim();
  if (!title) throw new UserTaskValidationError('title is required');
  if (title.length > USER_TASK_TITLE_MAX) {
    throw new UserTaskValidationError(`title must be at most ${USER_TASK_TITLE_MAX} characters`);
  }
  return title;
}

function normalizeRemindAt(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string') throw new UserTaskValidationError('remindAt must be an ISO date string');
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new UserTaskValidationError('remindAt must be an ISO date string');
  }
  return date.toISOString();
}

/**
 * The signed-in user's personal to-do list — the Todoist-style tasks under
 * Profile → "Needs your attention" and behind the sidebar tasks button.
 *
 * Every operation takes the owning user id; the repository scopes reads and
 * writes to it, so one member can never see or touch another's tasks.
 *
 * Reminders: a task may carry a `remindAt`. `processDueReminders` (swept by
 * `/api/cron/task-reminders`) emails the owner once that time passes. The app
 * also raises an in-app/browser notification client-side while it is open.
 */
export class UserTaskService {
  constructor(
    private readonly taskRepo: UserTaskRepository,
    private readonly userRepo: UserRepository,
    private readonly workspaceRepo: WorkspaceRepository,
    private readonly workspaceId: string,
    private readonly enqueue: EnqueueFn = enqueueSendEmail,
    private readonly appUrl: string = resolveAppUrl(),
  ) {}

  async list(userId: string): Promise<UserTask[]> {
    const rows = await this.taskRepo.listForUser(userId, { openLimit: OPEN_LIMIT, completedLimit: COMPLETED_LIMIT });
    return rows.map(toDto);
  }

  async create(userId: string, input: UserTaskInput): Promise<UserTask> {
    const row = await this.taskRepo.create(userId, {
      title: normalizeTitle(input.title),
      remind_at: normalizeRemindAt(input.remindAt),
    });
    await this.announce(userId);
    return toDto(row);
  }

  /** The owner's open tabs re-read their list. `ids` is the user, so other members ignore it. */
  private announce(userId: string): Promise<void> {
    return publishLiveEvent(this.workspaceId, LIVE_TOPICS.userTasks, [userId]);
  }

  /** Returns `null` when the task does not exist or is not the user's. */
  async update(userId: string, id: string, input: UserTaskUpdate): Promise<UserTask | null> {
    const patch: UserTaskPatch = {};
    if (input.title !== undefined) patch.title = normalizeTitle(input.title);
    if (input.remindAt !== undefined) {
      patch.remind_at = normalizeRemindAt(input.remindAt);
      // A new reminder time is a new reminder: let the sweep send it again.
      patch.reminder_sent_at = null;
    }
    if (input.completed !== undefined) {
      if (typeof input.completed !== 'boolean') {
        throw new UserTaskValidationError('completed must be a boolean');
      }
      patch.completed_at = input.completed ? new Date().toISOString() : null;
    }
    if (Object.keys(patch).length === 0) {
      throw new UserTaskValidationError('nothing to update');
    }
    const row = await this.taskRepo.update(id, userId, patch);
    if (row) await this.announce(userId);
    return row ? toDto(row) : null;
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const deleted = await this.taskRepo.delete(id, userId);
    if (deleted) await this.announce(userId);
    return deleted;
  }

  /**
   * Email every owner whose open task's reminder has passed. Due tasks are
   * claimed (stamped) atomically up front so overlapping sweeps never send
   * twice; owners are resolved in one batched lookup. A failed enqueue hands
   * its task back so the next sweep retries it; a missing email address keeps
   * the stamp (there is nothing to retry).
   */
  async processDueReminders(now: Date = new Date()): Promise<TaskReminderResult> {
    const claimedAt = now.toISOString();
    const due = await this.taskRepo.claimDueReminders(claimedAt, REMINDER_BATCH);
    if (due.length === 0) return { reminded: 0, notified: 0 };

    const ownerIds = [...new Set(due.map((t) => t.user_id))];
    const owners = await this.userRepo.findByIds(ownerIds);
    const emailById = new Map(owners.map((u) => [u.id, u.email]));
    const tasksUrl = await this.tasksUrl();

    const failed: string[] = [];
    let notified = 0;
    for (const task of due) {
      const email = emailById.get(task.user_id);
      if (!email) continue;
      try {
        await this.enqueue({ kind: 'task_reminder', to: email, taskTitle: task.title, tasksUrl });
        notified += 1;
      } catch (err) {
        console.error(`[UserTaskService] reminder for task ${task.id} failed:`, err);
        failed.push(task.id);
      }
    }

    await this.taskRepo.releaseReminders(failed, claimedAt);
    return { reminded: due.length - failed.length, notified };
  }

  /** Deep link to the Profile items tab, workspace-scoped when the slug resolves. */
  private async tasksUrl(): Promise<string> {
    try {
      const workspace = await this.workspaceRepo.findById(this.workspaceId);
      if (workspace?.slug) return `${this.appUrl}/w/${workspace.slug}/profile?tab=items`;
    } catch (err) {
      console.error('[UserTaskService] workspace slug lookup failed:', err);
    }
    return this.appUrl;
  }
}
