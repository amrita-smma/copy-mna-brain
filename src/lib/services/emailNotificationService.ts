import {
  AiWorkforceQueueRepository,
  RoutinesRepository,
  UserRepository,
  WorkspaceRepository,
} from '@/lib/repositories';
import type { WorkforceQueueRow } from '@/lib/repositories';
import { enqueueSendEmail } from '@/lib/queue';
import type { SendEmailPayload } from '@/lib/jobs/handlers/sendEmail';
import {
  ASK_OWNER_TOOL_NAME,
  MOVE_STAGE_TOOL_NAME,
  readAskOwnerArgs,
} from '@/lib/agents/analysis/hitl';

/**
 * Task lifecycle and insight refresh email notifications (MB-90, MB-558).
 *
 * Resolves the human who should hear about a workforce run or insight refresh,
 * then enqueues the appropriate transactional email onto the existing `send-email`
 * queue. Every public `notify*` method is **best-effort and non-throwing**:
 * notifications must never break the workflow step / request that triggered
 * them, so failures are caught and logged and the method resolves to `false`.
 *
 * Gated by `TASK_NOTIFICATIONS_ENABLED` (matching the `taskNotificationsEnabled`
 * flag in `src/lib/flags.ts`) — except a run that FAILED on its own (not a
 * user cancellation), whose email always goes out: a failure is the one
 * lifecycle event the user cannot otherwise learn about without watching the
 * queue. The env var is read directly rather than via the
 * Flags SDK `flag()` because most triggers fire from WDK workflow steps and
 * cron routes that have no request context for the SDK.
 */

type EnqueueFn = (payload: SendEmailPayload) => Promise<{ messageId: string | null }>;

/** Resolves whether notifications are enabled; injectable for tests. */
export type EnabledResolver = () => Promise<boolean>;

export interface NotificationDeps {
  workforceRepo: AiWorkforceQueueRepository;
  routinesRepo: RoutinesRepository;
  userRepo: UserRepository;
  workspaceRepo: WorkspaceRepository;
  /** Injectable for tests; defaults to the real Vercel-queue enqueue. */
  enqueue?: EnqueueFn;
  /** Base URL used to build deep links into the task UI. */
  appUrl?: string;
  /** Feature-flag gate; defaults to the TASK_NOTIFICATIONS_ENABLED env var. */
  isEnabled?: EnabledResolver;
}

interface Recipient {
  email: string;
  name: string;
}

export interface InsightRefreshedNotice {
  workspaceId: string;
  insightId: string;
  insightName: string;
  versionNo: number;
  ownerUserId: string | null;
}

export interface ApprovalDetails {
  /** Headline action, e.g. "Move NovaSpec Materials to L1 · Screening". */
  action?: string;
  company?: string;
  proposedAction?: string;
  reason?: string;
  changeField?: string;
  beforeValue?: string;
  afterValue?: string;
}

/**
 * Map a gated HITL tool call (name + args) to the structured fields the
 * approval email renders ("what's being proposed" + "change preview"). Mirrors
 * the in-app approval card derived in `traceMapper.deriveInterventionProposal`.
 * Returns `{}` for tools we don't have a structured layout for — the email
 * falls back to the plain `action` headline.
 */
export function deriveApprovalDetails(
  toolName: string | undefined,
  args: Record<string, unknown> | undefined,
): ApprovalDetails {
  const a = args && typeof args === 'object' ? args : {};
  if (toolName === MOVE_STAGE_TOOL_NAME) {
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const company = text(a.company_name);
    const reasonRaw = text(a.reason) ?? '';
    const note = text(a.note) ?? '';
    const reason =
      reasonRaw && note
        ? `${reasonRaw}\n\nNote: ${note}`
        : reasonRaw || (note ? `Note: ${note}` : undefined);
    // move_stage adds the stages' display labels to the interrupt args; fall
    // back to the raw keys the agent passed.
    const from = text(a.from_label) ?? text(a.from_stage) ?? 'current stage';
    const to = text(a.to_label) ?? text(a.to_stage) ?? 'next stage';
    return {
      action: company ? `Move ${company} to ${to}` : `Move company to ${to}`,
      company,
      proposedAction: `Move from ${from} to ${to}`,
      reason,
      changeField: 'Pipeline Stage',
      beforeValue: from,
      afterValue: to,
    };
  }
  if (toolName === ASK_OWNER_TOOL_NAME) {
    const ask = readAskOwnerArgs(a);
    if (!ask) return {};
    return {
      action: ask.question,
      proposedAction: `Recommended answer: ${ask.recommendation}`,
      reason: ask.rationale || undefined,
    };
  }
  return {};
}

function resolveAppUrl(): string {
  const explicit =
    process.env.APP_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    process.env.NEXTAUTH_URL;
  if (explicit) return explicit;
  // Local-dev fallback so the CTA button always renders while testing.
  return 'http://localhost:3000';
}

async function defaultIsEnabled(): Promise<boolean> {
  return process.env.TASK_NOTIFICATIONS_ENABLED === 'true';
}

// Timestamps are formatted in UTC for determinism (the workflow runtime has no
// user timezone). e.g. "April 28, 2:15 PM".
// Intl inserts a narrow no-break space (U+202F) before AM/PM in modern Node;
// normalize it to a regular space so output is stable and renders predictably.
function normalizeSpaces(s: string): string {
  return s.replace(/[\u202f\u2009\u00a0]/g, ' ');
}

// Built from separate date/time parts (joined with ", ") rather than a single
// combined format, because ICU renders the combined form as "April 28 at 2:15
// PM" — we want "April 28, 2:15 PM".
function fmtTime(d: Date): string {
  return normalizeSpaces(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'UTC',
    }).format(d),
  );
}

function fmtDateTime(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const datePart = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(d);
  return `${datePart}, ${fmtTime(d)}`;
}

// e.g. "Finished at 2:42 PM on April 28, 2026".
function fmtFinished(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const time = fmtTime(d);
  const date = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
  return `Finished at ${time} on ${date}`;
}

// e.g. "27 minutes" / "1 hour 5 minutes" / "45 seconds".
function fmtDuration(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
): string | undefined {
  if (!startIso || !endIso) return undefined;
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) {
    const sec = Math.max(1, Math.round(ms / 1000));
    return `${sec} second${sec === 1 ? '' : 's'}`;
  }
  if (totalMin < 60) return `${totalMin} minute${totalMin === 1 ? '' : 's'}`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const hh = `${h} hour${h === 1 ? '' : 's'}`;
  return m ? `${hh} ${m} minute${m === 1 ? '' : 's'}` : hh;
}

interface CompletedRow {
  label: string;
  value: string;
  highlight?: boolean;
}

// Parse an optional structured `results` array off the run output into RESULTS
// rows. Tolerant: anything that isn't a well-formed array is ignored (the email
// falls back to the free-text summary).
function parseResultRows(output: unknown): CompletedRow[] | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const results = (output as Record<string, unknown>).results;
  if (!Array.isArray(results)) return undefined;
  const rows: CompletedRow[] = [];
  for (const item of results) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.label !== 'string') continue;
    const value =
      typeof r.value === 'string'
        ? r.value
        : typeof r.value === 'number'
          ? String(r.value)
          : undefined;
    if (value === undefined) continue;
    rows.push({ label: r.label, value, highlight: r.highlight === true });
  }
  return rows.length ? rows : undefined;
}

export class EmailNotificationService {
  private readonly workforceRepo: AiWorkforceQueueRepository;
  private readonly routinesRepo: RoutinesRepository;
  private readonly userRepo: UserRepository;
  private readonly workspaceRepo: WorkspaceRepository;
  private readonly enqueue: EnqueueFn;
  private readonly appUrl: string;
  private readonly isEnabled: EnabledResolver;

  constructor(deps: NotificationDeps) {
    this.workforceRepo = deps.workforceRepo;
    this.routinesRepo = deps.routinesRepo;
    this.userRepo = deps.userRepo;
    this.workspaceRepo = deps.workspaceRepo;
    this.enqueue = deps.enqueue ?? enqueueSendEmail;
    this.appUrl = (deps.appUrl ?? resolveAppUrl()).replace(/\/+$/, '');
    this.isEnabled = deps.isEnabled ?? defaultIsEnabled;
  }

  /** Task reached terminal `succeeded`. Cron runs are skipped — the digest covers them. */
  async notifyTaskCompleted(runId: string): Promise<boolean> {
    return this.dispatch(runId, 'task_completed', async (run, recipient) => {
      if (run.trigger_source === 'cron') return null; // rolls up into the digest
      const output =
        run.output && typeof run.output === 'object'
          ? (run.output as Record<string, unknown>)
          : null;
      const summary =
        output && typeof output.final_message === 'string'
          ? output.final_message
          : undefined;

      // SUMMARY rows from the run's real lifecycle data.
      const summaryRows: CompletedRow[] = [];
      const taskDesc = this.taskDescription(run);
      if (taskDesc) summaryRows.push({ label: 'Task', value: taskDesc });
      const started = fmtDateTime(run.started_at);
      if (started) summaryRows.push({ label: 'Started', value: started });
      const completed = fmtDateTime(run.ended_at);
      if (completed) summaryRows.push({ label: 'Completed', value: completed });
      const duration = fmtDuration(run.started_at, run.ended_at);
      if (duration) summaryRows.push({ label: 'Duration', value: duration });

      return {
        kind: 'task_completed',
        to: recipient.email,
        taskName: this.taskName(run),
        taskUrl: await this.taskUrl(runId, run.workspace_id),
        finishedAtLabel: fmtFinished(run.ended_at),
        summaryRows: summaryRows.length ? summaryRows : undefined,
        resultRows: parseResultRows(output),
        summary,
      };
    });
  }

  /**
   * Task paused on a gated tool — `waiting_for_human_input`. Pass the gated
   * tool's name + args (from the HITL interrupt) so the email can render the
   * structured "what's being proposed" / "change preview" card; `action` is
   * the human-readable fallback headline (the interrupt description).
   * `recipientUserId` is the user the intervention is addressed to (e.g. the
   * insight owner for a refresh run); without it the usual run recipient is
   * used.
   */
  async notifyTaskWaitingApproval(
    runId: string,
    opts: {
      action: string;
      toolName?: string;
      toolArgs?: Record<string, unknown>;
      recipientUserId?: string | null;
    },
  ): Promise<boolean> {
    return this.dispatch(runId, 'task_waiting_approval', async (run, recipient) => {
      const details = deriveApprovalDetails(opts.toolName, opts.toolArgs);
      const action =
        (details.action ?? opts.action ?? '').trim() ||
        'A task needs your approval';
      return {
        kind: 'task_waiting_approval',
        to: recipient.email,
        action,
        taskName: this.taskName(run),
        taskUrl: await this.taskUrl(runId, run.workspace_id),
        company: details.company,
        proposedAction: details.proposedAction,
        reason: details.reason,
        changeField: details.changeField,
        beforeValue: details.beforeValue,
        afterValue: details.afterValue,
      };
    }, opts.recipientUserId);
  }

  /**
   * Task reached terminal `failed` — agent error, stuck-run reaper, or user
   * cancellation. Only a cancellation (`cancelled: true`) is subject to the
   * notifications flag; every other failure is always emailed.
   */
  async notifyTaskFailed(
    runId: string,
    opts: { cancelled?: boolean; reason?: string } = {},
  ): Promise<boolean> {
    const alwaysSend = opts.cancelled !== true;
    return this.dispatch(runId, 'task_failed', async (run, recipient) => {
      const error =
        run.error && typeof run.error === 'object'
          ? (run.error as Record<string, unknown>)
          : null;
      const cancelled =
        opts.cancelled ?? error?.code === 'cancelled_by_user';
      const reason =
        opts.reason ??
        (typeof error?.message === 'string'
          ? error.message
          : typeof error?.reason === 'string'
            ? error.reason
            : undefined);
      return {
        kind: 'task_failed',
        to: recipient.email,
        taskName: this.taskName(run),
        reason,
        cancelled,
        taskUrl: await this.taskUrl(runId, run.workspace_id),
      };
    }, undefined, { alwaysSend });
  }

  /** Mid-run progress milestone (driven by the agent's notify_progress tool). */
  async notifyTaskProgress(
    runId: string,
    opts: { progress: string; headline?: string },
  ): Promise<boolean> {
    if (!opts.progress?.trim()) return false;
    return this.dispatch(runId, 'task_progress', async (run, recipient) => ({
      kind: 'task_progress',
      to: recipient.email,
      taskName: this.taskName(run),
      progress: opts.progress,
      headline: opts.headline,
      taskUrl: await this.taskUrl(runId, run.workspace_id),
    }));
  }

  /** Opportunity insight — a company passed a screening milestone. */
  async notifyTaskInsight(
    runId: string,
    opts: {
      companyName: string;
      level: string;
      detail?: string;
      confidencePct?: number;
    },
  ): Promise<boolean> {
    if (!opts.companyName?.trim() || !opts.level?.trim()) return false;
    return this.dispatch(runId, 'task_insight', async (run, recipient) => ({
      kind: 'task_insight',
      to: recipient.email,
      companyName: opts.companyName,
      level: opts.level,
      detail: opts.detail,
      confidencePct: opts.confidencePct,
      taskUrl: await this.taskUrl(runId, run.workspace_id),
    }));
  }

  /**
   * An insight was updated by a scheduled refresh run. Notifies the insight's
   * owner (never the run's triggerer). Best-effort and non-throwing.
   */
  async notifyInsightRefreshed(
    notice: InsightRefreshedNotice,
  ): Promise<boolean> {
    const tag = `[EmailNotificationService] insight_refreshed insight=${notice.insightId}`;
    try {
      if (!(await this.isEnabled())) {
        console.info(`${tag} skipped: notifications feature flag is off`);
        return false;
      }
      if (!notice.ownerUserId) {
        console.info(`${tag} skipped: no ownerUserId`);
        return false;
      }
      const recipient = await this.lookupUser(notice.ownerUserId);
      if (!recipient) {
        console.info(
          `${tag} skipped: owner has no email on file (ownerUserId=${notice.ownerUserId})`,
        );
        return false;
      }
      const insightUrl = await this.insightUrl(notice.insightId, notice.workspaceId);
      const payload: SendEmailPayload = {
        kind: 'insight_refreshed',
        to: recipient.email,
        insightName: notice.insightName,
        versionNo: notice.versionNo,
        insightUrl,
      };
      const { messageId } = await this.enqueue(payload);
      console.info(
        `${tag} enqueued to ${recipient.email} (queue messageId=${messageId ?? 'null'})`,
      );
      return true;
    } catch (err) {
      console.error(`${tag} failed:`, err);
      return false;
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  /**
   * Shared envelope: gate check → load run → resolve recipient → build payload
   * → enqueue. `build` returns `null` to silently skip (e.g. cron completion).
   * Any thrown error is swallowed and logged so callers stay safe.
   */
  private async dispatch(
    runId: string,
    label: string,
    build: (
      run: WorkforceQueueRow,
      recipient: Recipient,
    ) => Promise<SendEmailPayload | null>,
    recipientUserId?: string | null,
    opts: { alwaysSend?: boolean } = {},
  ): Promise<boolean> {
    const tag = `[EmailNotificationService][${label}] run=${runId}`;
    if (!opts.alwaysSend && !(await this.isEnabled())) {
      console.info(`${tag} skipped: notifications feature flag is off`);
      return false;
    }
    try {
      const run = await this.workforceRepo.findById(runId);
      if (!run) {
        console.info(`${tag} skipped: run not found`);
        return false;
      }
      const recipient = recipientUserId
        ? await this.lookupUser(recipientUserId)
        : await this.resolveRecipient(run);
      if (!recipient) {
        console.info(
          `${tag} skipped: no recipient with an email (recipient_user_id=${recipientUserId ?? 'null'}, triggered_by_user_id=${run.triggered_by_user_id ?? 'null'}, origin_routine_id=${run.origin_routine_id ?? 'null'})`,
        );
        return false;
      }
      const payload = await build(run, recipient);
      if (!payload) {
        console.info(
          `${tag} skipped: not applicable for this run (e.g. cron run → digest)`,
        );
        return false;
      }
      const { messageId } = await this.enqueue(payload);
      console.info(
        `${tag} enqueued to ${recipient.email} (queue messageId=${messageId ?? 'null'})`,
      );
      return true;
    } catch (err) {
      console.error(`${tag} failed:`, err);
      return false;
    }
  }

  /**
   * Who hears about this run: the user who triggered it (chat/api), or — for
   * cron-fired runs with no triggerer — the routine's creator. Returns null
   * when no recipient with an email can be resolved.
   */
  private async resolveRecipient(
    run: WorkforceQueueRow,
  ): Promise<Recipient | null> {
    if (run.triggered_by_user_id) {
      const user = await this.lookupUser(run.triggered_by_user_id);
      if (user) return user;
    }
    if (run.origin_routine_id) {
      const routine = await this.routinesRepo.findById(run.origin_routine_id);
      if (routine?.created_by) {
        const user = await this.lookupUser(routine.created_by);
        if (user) return user;
      }
    }
    return null;
  }

  private async lookupUser(userId: string): Promise<Recipient | null> {
    const [user] = await this.userRepo.findByIds([userId]);
    if (!user?.email) return null;
    return { email: user.email, name: user.name };
  }

  private taskName(run: WorkforceQueueRow): string {
    const title = run.title?.trim();
    return title && title.length > 0 ? title : 'Your task';
  }

  // Short description of what the task was asked to do, for the SUMMARY "Task"
  // row — pulled from the run's prompt/instruction and truncated.
  private taskDescription(run: WorkforceQueueRow): string | undefined {
    const input =
      run.input && typeof run.input === 'object'
        ? (run.input as Record<string, unknown>)
        : {};
    const raw =
      typeof input.prompt === 'string'
        ? input.prompt
        : typeof input.instruction === 'string'
          ? input.instruction
          : '';
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    return trimmed.length > 90 ? `${trimmed.slice(0, 89).trimEnd()}…` : trimmed;
  }

  // Falls back to the un-prefixed URL (today's behavior) if the workspace
  // lookup fails — a wrong-but-working deeplink beats a broken email.
  private async taskUrl(runId: string, workspaceId: string): Promise<string | undefined> {
    if (!this.appUrl) return undefined;
    try {
      const workspace = await this.workspaceRepo.findById(workspaceId);
      if (workspace?.slug) {
        return `${this.appUrl}/w/${workspace.slug}/ai-workforce/tasks/${runId}`;
      }
    } catch (err) {
      console.error(`[EmailNotificationService] taskUrl: workspace lookup failed for ${workspaceId}:`, err);
    }
    return `${this.appUrl}/ai-workforce/tasks/${runId}`;
  }

  // Builds the insight link scoped by workspace slug when available, falling back
  // to the un-prefixed URL if the workspace lookup fails or has no slug.
  private async insightUrl(insightId: string, workspaceId: string): Promise<string | undefined> {
    if (!this.appUrl) return undefined;
    try {
      const workspace = await this.workspaceRepo.findById(workspaceId);
      if (workspace?.slug) {
        return `${this.appUrl}/w/${workspace.slug}/insight/${insightId}`;
      }
    } catch (err) {
      console.error(
        `[EmailNotificationService] insightUrl: workspace lookup failed for ${workspaceId}:`,
        err,
      );
    }
    return `${this.appUrl}/insight/${insightId}`;
  }
}
