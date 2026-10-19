import { randomUUID } from 'crypto';
import type { BaseMessage } from '@langchain/core/messages';
import {
  AgentCheckpointRepository,
  type AiWorkforceQueueRepository,
  type DbClient,
  type WorkforceQueueRow,
  type WorkforceStatus,
} from '@/lib/repositories';
import { enqueueAgentRun } from '@/lib/workforce';
import { matchMessageTimestamps } from '@/lib/workforce/traceMapper';
import { captureWorkspaceEvent } from '@/lib/posthog-server';
import type { PendingUserMessage } from '@/lib/db/schema';
import type { ChatAttachmentRef } from './chatAttachmentService';
import type { InsightFailedRefreshRun } from '@/lib/insights/types';

function readText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The failure reason shown for an unsuccessful run. Every writer uses
 * `{ code, message }` (agent failures, the reaper, publish refusals) except
 * cancellation, which writes `{ code: 'cancelled_by_user', reason? }`.
 */
export function describeRunFailure(
  status: WorkforceStatus,
  error: Record<string, unknown> | null,
): string {
  const code = readText(error?.code);
  if (code === 'cancelled_by_user') {
    const reason = readText(error?.reason);
    return reason ? `Cancelled by user: ${reason}` : 'Cancelled by user';
  }
  const message = readText(error?.message);
  if (message) return message;
  if (code) return code;
  if (status === 'timed_out') return 'Timed out';
  if (status === 'rejected') return 'Rejected';
  return 'Failed without a recorded reason';
}

export interface ChatHandoffInput {
  agent_name: string;
  title: string;
  instruction: string;
  conversation_id?: string;
  tool_call_id?: string;
  user_id?: string;
  priority?: number;
  effort?: string;
  attachments?: ChatAttachmentRef[];
}

export interface SubmitUserMessageInput {
  runId: string;
  userId: string;
  text: string;
}

export type SubmitUserMessageResult =
  | {
      kind: 'attached';
      message_id: string;
      queue_position: number;
      status: WorkforceStatus;
    }
  | { kind: 'forked'; new_run_id: string; status: WorkforceStatus };

// Domain errors for submitUserMessage. The API layer maps these to 4xx
// responses; everything else becomes a 500.
export class TaskNotFoundError extends Error {
  constructor(runId: string) {
    super(`workforce run ${runId} not found`);
    this.name = 'TaskNotFoundError';
  }
}

export class TaskOwnershipError extends Error {
  constructor() {
    super('Only the task creator can send updates to this task');
    this.name = 'TaskOwnershipError';
  }
}

export class TaskBusyError extends Error {
  constructor(status: WorkforceStatus) {
    super(
      `task is currently '${status}'; wait until it pauses or finishes before sending an update`,
    );
    this.name = 'TaskBusyError';
  }
}

// Statuses where the agent is actively burning compute. Buffering a new
// user message during these is unsafe (the agent might commit a tool call
// before reading the buffer), so we reject at the API layer.
const THINKING_STATUSES: readonly WorkforceStatus[] = [
  'running',
  'waiting_for_subagent',
] as const;

// Statuses where the row is paused/queued and a new user message can be
// safely buffered for the next invoke/resume.
const ATTACH_STATUSES: readonly WorkforceStatus[] = [
  'pending',
  'waiting_for_human_input',
  'resume_ready',
] as const;

export class AiWorkforceService {
  constructor(
    private readonly queueRepo: AiWorkforceQueueRepository,
    private readonly db: DbClient,
    private readonly checkpointRepo: AgentCheckpointRepository = new AgentCheckpointRepository(db),
  ) {}

  /** Best-effort: a timestamp lookup must never break the trace endpoint. */
  async getMessageTimestamps(threadId: string, messages: BaseMessage[]): Promise<(string | null)[] | undefined> {
    try {
      const writes = await this.checkpointRepo.listMessageWrites(threadId);
      return matchMessageTimestamps(messages, writes);
    } catch (err) {
      console.warn('[workforce] trace timestamps unavailable', err);
      return undefined;
    }
  }

  /**
   * Enqueue a run spawned from the AI CoPilot chat. The agent_name is the
   * routing target (e.g. "outbound_pipeline_writer"); input carries the
   * instruction and any chat context the worker will need.
   */
  listQueue(opts: { limit?: number } = {}): Promise<WorkforceQueueRow[]> {
    return this.queueRepo.list(opts);
  }

  findByToolCallId(toolCallId: string): Promise<WorkforceQueueRow | null> {
    return this.queueRepo.findByToolCallId(toolCallId);
  }

  findById(id: string): Promise<WorkforceQueueRow | null> {
    return this.queueRepo.findById(id);
  }

  /**
   * The Workforce nav item's badges for one user: their unseen failures (red),
   * and the workspace's queue (yellow) — `queue` counts runs waiting to start
   * or resume plus the ones running, `running` alone drives the blinking dot.
   */
  async getNavSummary(
    userId: string,
  ): Promise<{ unseen_failures: number; queue: number; running: number }> {
    const counts = await this.queueRepo.countNavSummary(userId);
    return {
      unseen_failures: counts.unseenFailures,
      queue: counts.queued + counts.running,
      running: counts.running,
    };
  }

  /**
   * The owner opened a failed run: it no longer counts as an unseen failure.
   * Skips the write unless the row is a failure still marked unseen.
   */
  async markFailureSeen(run: WorkforceQueueRow, userId: string): Promise<boolean> {
    if (run.failure_seen_at) return false;
    if (run.status !== 'failed' && run.status !== 'timed_out') return false;
    return this.queueRepo.markFailureSeen(run.id, userId);
  }

  /**
   * An insight's refresh runs that failed or were cancelled (newest 50), with
   * their failure reason, for the insight's version history. A failed run
   * never writes a version, so this is the only place it shows there.
   */
  async listFailedRefreshRuns(insightId: string): Promise<InsightFailedRefreshRun[]> {
    const rows = await this.queueRepo.findUnsuccessfulRefreshRunsByInsightId(insightId);
    return rows.map((row) => ({
      run_id: row.id,
      status: row.status,
      reason: describeRunFailure(row.status, row.error ?? null),
      created_at: row.created_at,
      ended_at: row.ended_at,
    }));
  }

  /** See AiWorkforceQueueRepository.getGlobalQueuePositions. */
  getGlobalQueuePositions(
    ids: string[],
  ): Promise<Map<string, { aheadGlobally: number; aheadOtherWorkspaces: number }>> {
    return this.queueRepo.getGlobalQueuePositions(ids);
  }

  /**
   * Enqueue a chat handoff. Goes through enqueueAgentRun() so we get:
   *   - idempotency on tool_call_id (set as idempotency_key — same handoff
   *     approved twice = one row, not two)
   *   - fire-and-forget dispatcher trigger via Next.js after() so the
   *     workflow starts within ms instead of waiting up to 60s for cron
   *   - automatic Haiku title generation from input.prompt (we mirror
   *     the instruction into input.prompt so the generator + runAgent
   *     can both read it)
   *   - triggered_by_user_id populated for owner attribution
   */
  async enqueueFromChat(data: ChatHandoffInput): Promise<WorkforceQueueRow> {
    const { runId } = await enqueueAgentRun(this.db, {
      agentName: data.agent_name,
      triggerSource: 'chat',
      triggerMeta: {
        conversation_id: data.conversation_id ?? null,
        tool_call_id: data.tool_call_id ?? null,
        user_id: data.user_id ?? null,
      },
      // Mirror the instruction into both fields. runAgent prefers `prompt`
      // when present; the explicit `instruction` is preserved for any
      // downstream consumer that still keys off Dicki's original shape.
      input: {
        title: data.title,
        instruction: data.instruction,
        prompt: data.instruction,
        effort: data.effort ?? 'medium',
        ...(data.attachments && data.attachments.length > 0
          ? { attachments: data.attachments }
          : {}),
      },
      priority: data.priority ?? 0,
      triggeredByUserId: data.user_id ?? null,
      idempotencyKey: data.tool_call_id ?? null,
    });

    const row = await this.queueRepo.findById(runId);
    if (!row) {
      throw new Error(
        `enqueueFromChat: row ${runId} was inserted but findById returned null`,
      );
    }

    captureWorkspaceEvent({
      workspaceId: row.workspace_id,
      distinctId: data.user_id ?? 'server',
      event: 'workforce_task_assigned',
      properties: {
        run_id: runId,
        agent_name: data.agent_name,
        priority: data.priority ?? 0,
        has_conversation: Boolean(data.conversation_id),
      },
    });

    return row;
  }

  /**
   * Submit a free-form user update against a workforce run.
   *
   * Branches on status:
   *   - thinking (running, waiting_for_subagent) → TaskBusyError (409). The
   *     agent is actively executing; a write here could race a tool call.
   *   - paused / queued (pending, waiting_for_human_input, resume_ready) →
   *     append to the row's pending_user_messages buffer. runAgent's load
   *     step consumes the buffer atomically on the next invoke/resume.
   *   - terminal (succeeded, failed, rejected, timed_out) → flip to pending and reopen
   *     workforce row that re-enters the same LangGraph thread (the agent
   *     sees the prior conversation's checkpoint) with the user's text as
   *     the next HumanMessage.
   */
  async submitUserMessage(
    input: SubmitUserMessageInput,
  ): Promise<SubmitUserMessageResult> {
    const trimmed = input.text.trim();
    if (!trimmed) {
      throw new Error('text is required');
    }

    const row = await this.queueRepo.findById(input.runId);
    if (!row) {
      throw new TaskNotFoundError(input.runId);
    }
    if (row.triggered_by_user_id !== input.userId) {
      throw new TaskOwnershipError();
    }

    if (THINKING_STATUSES.includes(row.status)) {
      throw new TaskBusyError(row.status);
    }

    const TERMINAL_STATUSES: readonly WorkforceStatus[] = [
      'succeeded',
      'failed',
      'rejected',
      'timed_out',
    ] as const;

    if (ATTACH_STATUSES.includes(row.status) || TERMINAL_STATUSES.includes(row.status)) {
      const message: PendingUserMessage = {
        id: randomUUID(),
        text: trimmed,
        submitted_at: new Date().toISOString(),
        submitted_by_user_id: input.userId,
      };
      const isTerminal = TERMINAL_STATUSES.includes(row.status);
      const { row: updated, queue_position } =
        await this.queueRepo.appendPendingUserMessage(input.runId, message, isTerminal ? 'pending' : undefined);
      return {
        kind: 'attached',
        message_id: message.id,
        queue_position,
        status: updated.status,
      };
    }

    // Terminal — reopen by flipping the row to pending to resume the original
    // LangGraph thread (input.follow_up_thread_id signals runAgent to use
    // the original runId as the checkpoint thread_id).
    const followUpTitle =
      typeof row.input === 'object' &&
      row.input !== null &&
      typeof (row.input as Record<string, unknown>).title === 'string'
        ? ((row.input as Record<string, unknown>).title as string)
        : (row.title ?? row.agent_name);

    const parentEffort =
      typeof row.input === 'object' &&
      row.input !== null &&
      typeof (row.input as Record<string, unknown>).effort === 'string'
        ? ((row.input as Record<string, unknown>).effort as string)
        : undefined;

    const { runId: newRunId } = await enqueueAgentRun(this.db, {
      agentName: row.agent_name,
      triggerSource: 'chat',
      triggerMeta: {
        follow_up_from_run_id: row.id,
        submitted_by_user_id: input.userId,
      },
      input: {
        title: followUpTitle,
        instruction: trimmed,
        prompt: trimmed,
        follow_up_thread_id: row.id,
        ...(parentEffort ? { effort: parentEffort } : {}),
      },
      priority: row.priority,
      parentRunId: row.id,
      triggeredByUserId: input.userId,
    });

    return { kind: 'forked', new_run_id: newRunId, status: 'pending' };
  }
}
