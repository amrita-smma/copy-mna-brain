import { FatalError, RetryableError } from 'workflow';
import {
  extractMessageText,
  getWorkforceAgentGraph,
  HumanMessage,
} from '@/lib/agents/analysis';
import { ToolTimeoutError } from '@/lib/agents/withToolTimeout';
import {
  AiWorkforceQueueRepository,
  RoutinesRepository,
  UserRepository,
} from '@/lib/repositories';
import { EmailNotificationService } from '@/lib/services/emailNotificationService';
import { NotificationService } from '@/lib/services/notificationService';
import type { NotificationKind } from '@/lib/notifications/types';
import { createDb } from '@/lib/server/db';
import { dispatcherTick } from './dispatcher';

function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.includes('rate_limit') ||
    msg.includes('429') ||
    msg.includes('Rate limit')
  );
}

/**
 * AI Workforce agent runtime (MB-147 Tier 3).
 *
 * Reuses the same LangGraph-based agent that powers the copilot chat
 * (`src/lib/agents/analysis`) — same model, same system prompt, same tool set.
 * The workforce-specific contribution is the orchestration: load the queue
 * row, feed `input.prompt` (or `input.instruction` for MB-151
 * propose_workforce_handoff handoffs) into the agent with `runId` as the LangGraph
 * thread_id, capture the final message, persist to `output`.
 *
 * Per the RFC: ai_workforce_queue.id IS the LangGraph thread_id. Each
 * workforce run gets its own checkpoint thread, isolated from copilot chats
 * (which key off copilot_chats.id).
 *
 * Resumes (rows claimed from status='resume_ready') carry a JSON-encoded
 * resume payload in `resume_token`. When present, runAgent calls
 * `graph.resume` instead of `graph.invoke`. The HITL decision route writes
 * this payload; runAgent clears it once consumed (any outcome — success,
 * pause, fail — so WDK step retries on a transient resume failure still
 * see the payload).
 *
 * WDK constraints:
 *   - The workflow function body runs in a sandboxed VM (no fetch, no node
 *     modules). All real I/O lives in step functions.
 *   - Steps have full Node.js access — that's where the LangChain agent runs.
 *   - Errors thrown from steps trigger WDK's retry policy unless wrapped in
 *     FatalError. We use FatalError for "this row should not be retried."
 */

interface LoadResult {
  prompt: string;
  resumePayloadJson: string | null;
  // LangGraph thread_id to use for the invoke. Usually equals runId, but
  // for a "follow-up" row spawned from a terminal task via the TaskCanvas
  // composer, we override to the original runId so the new run sees the
  // prior conversation's checkpoint.
  threadId: string;
  // Free-form user updates submitted via /api/workforce-queue/[id]/message
  // while the row was paused/queued. Already cleared from the DB by the
  // consume call below; the workflow drains them through the agent.
  pendingMessages: string[];
}

async function loadAndHeartbeat(runId: string): Promise<LoadResult> {
  'use step';
  const db = createDb();
  const repo = new AiWorkforceQueueRepository(db);

  const row = await repo.findById(runId);
  if (!row) {
    throw new FatalError(`ai_workforce_queue row ${runId} not found`);
  }
  if (row.status !== 'running') {
    throw new FatalError(
      `runId ${runId} is in status ${row.status}, expected 'running'`,
    );
  }

  // Accept `prompt` (MB-147 canonical) OR `instruction` (MB-151
  // propose_workforce_handoff convention). Either keyed prompt-string is fine;
  // we prefer `prompt` when both are present.
  const input =
    typeof row.input === 'object' && row.input !== null
      ? (row.input as Record<string, unknown>)
      : {};
  const candidate = input.prompt ?? input.instruction;
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new FatalError(
      `runId ${runId} has no usable prompt (input.prompt and input.instruction both empty/missing)`,
    );
  }

  // follow_up_thread_id: set by AiWorkforceService.submitUserMessage when
  // the user sends a message against a terminal task — we resume the same
  // LangGraph checkpoint thread so the agent has prior context.
  const followUp = input.follow_up_thread_id;
  const threadId =
    typeof followUp === 'string' && followUp.trim() ? followUp : runId;

  // Read-and-clear buffered updates atomically; if the consume step fails
  // mid-run, WDK retries the whole step — since the consume is wrapped in
  // its own transaction, the buffer is either fully drained or untouched.
  const pending = await repo.consumePendingUserMessages(runId);

  await repo.heartbeat(runId);
  return {
    prompt: candidate,
    resumePayloadJson: row.resume_token ?? null,
    threadId,
    pendingMessages: pending.map((m) => m.text),
  };
}

type InvokeStepResult =
  | {
      kind: 'completed';
      finalMessage: string;
      messageCount: number;
      toolCallCount: number;
    }
  | {
      kind: 'interrupted';
      reason: string;
      // The gated tool that triggered the HITL pause, surfaced so the
      // approval notification can render a structured proposal card.
      toolName?: string;
      toolArgs?: Record<string, unknown>;
    };

// Build the interrupted step-result from a HITL actionRequest, capturing the
// gated tool name + args so the approval notification can render a structured
// proposal card. `description` is the human-readable headline fallback.
function interruptedFrom(first: {
  name?: string;
  description?: unknown;
  args?: unknown;
}): Extract<InvokeStepResult, { kind: 'interrupted' }> {
  const reason =
    typeof first.description === 'string' && first.description.trim()
      ? first.description
      : `Awaiting approval for ${first.name ?? 'tool call'}`;
  return {
    kind: 'interrupted',
    reason,
    toolName: typeof first.name === 'string' ? first.name : undefined,
    toolArgs:
      first.args && typeof first.args === 'object'
        ? (first.args as Record<string, unknown>)
        : undefined,
  };
}

async function invokeAgent(
  runId: string,
  prompt: string,
  resumePayloadJson: string | null,
  threadId: string,
  pendingMessages: string[],
): Promise<InvokeStepResult> {
  'use step';
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new FatalError('ANTHROPIC_API_KEY is not set');
  }

  const graph = await getWorkforceAgentGraph();
  if (!graph) {
    // Returns null on initialization failure (logs the cause). Surface as
    // retryable in case it was a transient DB blip during
    // PostgresSaver.setup().
    throw new RetryableError('workforce agent graph unavailable');
  }

  // Build the message list. For a fresh invoke this is the row's prompt
  // followed by any buffered user updates. For a resume we feed only the
  // resume payload first (the agent picks up where it left off); buffered
  // updates are appended via a follow-up invoke after the resume returns
  // (or are skipped if the resume itself interrupted again — they stay
  // buffered for the next claim).
  const result = resumePayloadJson
    ? await graph.resume(runId, JSON.parse(resumePayloadJson))
    : await graph.invoke(
        {
          messages: [
            new HumanMessage(prompt),
            ...pendingMessages.map((t) => new HumanMessage(t)),
          ],
        },
        { configurable: { thread_id: threadId }, recursionLimit: 50 },
      );

  // HITL interrupt fired — the agent has paused awaiting a human decision.
  // Hand off to the decision endpoint via status; don't finalize and don't
  // throw (we'd rather not call markFailed for a healthy pause).
  if (result.interrupt?.actionRequests?.length) {
    return interruptedFrom(result.interrupt.actionRequests[0]);
  }

  // Resume branch only: drain any user updates that landed while the row
  // was paused. We do this via a fresh invoke on the same thread so the
  // agent sees the updates as new HumanMessages in the existing
  // conversation. If this follow-up itself interrupts or errors, it's
  // handled by the same WDK retry envelope as the main invoke.
  let finalResult = result;
  if (resumePayloadJson && pendingMessages.length > 0) {
    finalResult = await graph.invoke(
      { messages: pendingMessages.map((t) => new HumanMessage(t)) },
      { configurable: { thread_id: threadId }, recursionLimit: 50 },
    );
    if (finalResult.interrupt?.actionRequests?.length) {
      return interruptedFrom(finalResult.interrupt.actionRequests[0]);
    }
  }

  const messages = finalResult.messages ?? [];
  const lastMessage = messages[messages.length - 1];
  const finalMessage = extractMessageText(lastMessage);

  // tool_calls is an AIMessage-only field; BaseMessage typings don't include
  // it, so we widen the type via unknown before reading.
  const toolCallCount = messages.filter((m) => {
    const calls = (m as unknown as { tool_calls?: unknown[] }).tool_calls;
    return Array.isArray(calls) && calls.length > 0;
  }).length;

  return {
    kind: 'completed',
    finalMessage,
    messageCount: messages.length,
    toolCallCount,
  };
}

async function finalize(
  runId: string,
  result: Extract<InvokeStepResult, { kind: 'completed' }>,
): Promise<void> {
  'use step';
  const db = createDb();
  const repo = new AiWorkforceQueueRepository(db);
  await repo.clearResumeToken(runId);
  await repo.markSucceeded(runId, {
    final_message: result.finalMessage,
    message_count: result.messageCount,
    tool_call_count: result.toolCallCount,
  });
  await kickDispatcher(db);
  // Best-effort completion notification (MB-90). Skips cron runs internally —
  // those roll up into the routine digest instead.
  await makeNotifier(db).notifyTaskCompleted(runId);
}

async function markWaitingStep(
  runId: string,
  reason: string,
  toolName?: string,
  toolArgs?: Record<string, unknown>,
): Promise<void> {
  'use step';
  const db = createDb();
  const repo = new AiWorkforceQueueRepository(db);
  await repo.clearResumeToken(runId);
  await repo.markWaitingForHumanInput(runId, reason);
  await kickDispatcher(db);
  // The reason is the human-readable fallback; toolName/toolArgs let the email
  // render the structured proposal card (e.g. promote_to_l1 → L0→L1).
  await makeNotifier(db).notifyTaskWaitingApproval(runId, {
    action: reason,
    toolName,
    toolArgs,
  });
}

async function markFailedStep(
  runId: string,
  errorPayload: Record<string, unknown>,
): Promise<void> {
  'use step';
  const db = createDb();
  const repo = new AiWorkforceQueueRepository(db);
  await repo.clearResumeToken(runId);
  await repo.markFailed(runId, errorPayload);
  await kickDispatcher(db);
  const reason =
    typeof errorPayload.message === 'string' ? errorPayload.message : undefined;
  await makeNotifier(db).notifyTaskFailed(runId, { cancelled: false, reason });
}

// Build an EmailNotificationService bound to this step's db. Notifications are
// best-effort — the service swallows its own errors, so this never throws into
// the workflow.
function makeNotifier(db: ReturnType<typeof createDb>): EmailNotificationService {
  return new EmailNotificationService({
    workforceRepo: new AiWorkforceQueueRepository(db),
    routinesRepo: new RoutinesRepository(db),
    userRepo: new UserRepository(db),
  });
}

// Appended via the dispatcher's read-modify-write on error.notifications, so
// it merges with — and does not clobber — the markFailedStep payload above.
async function dispatchNotificationStep(
  runId: string,
  kind: NotificationKind,
  overrides: { title?: string; description?: string } = {},
): Promise<void> {
  'use step';
  const db = createDb();
  const repo = new AiWorkforceQueueRepository(db);
  const service = new NotificationService(repo);
  try {
    await service.dispatch(runId, kind, overrides);
  } catch (err) {
    console.error('[runAgent] notification dispatch failed:', err);
  }
}

// Reactive trigger: when the current run leaves status='running' (succeeded,
// paused, or failed), kick the dispatcher so the next queued/resume_ready row
// claims the slot immediately. The cron tick remains the liveness fallback.
// Errors are swallowed — the cron will pick up anything we miss here.
async function kickDispatcher(
  db: ReturnType<typeof createDb>,
): Promise<void> {
  try {
    await dispatcherTick(db);
  } catch (err) {
    console.error('[runAgent] dispatcher kick failed:', err);
  }
}

export async function runAgent({ runId }: { runId: string }): Promise<void> {
  'use workflow';
  const { prompt, resumePayloadJson, threadId, pendingMessages } =
    await loadAndHeartbeat(runId);

  // TODO(Tier 3+): heartbeat periodically inside long invokeAgent runs so
  // legitimate slow LLM/tool work doesn't trip the reaper's 5min staleness
  // window. The single heartbeat in loadAndHeartbeat covers the no-op-fast
  // case; agents that run > ~4 min need a sidecar heartbeat loop or the
  // step itself needs to break into smaller turns.
  try {
    const result = await invokeAgent(
      runId,
      prompt,
      resumePayloadJson,
      threadId,
      pendingMessages,
    );
    if (result.kind === 'interrupted') {
      // Healthy pause: HITL middleware caught a gated tool call. The decision
      // endpoint will re-enqueue the resume by writing status='resume_ready'.
      await markWaitingStep(
        runId,
        result.reason,
        result.toolName,
        result.toolArgs,
      );
      return;
    }
    await finalize(runId, result);
  } catch (err) {
    // WDK has already exhausted step retries by the time we get here.
    // Persist a terminal failure so the reaper doesn't have to.
    await markFailedStep(runId, {
      code: 'agent_execution_failed',
      message: err instanceof Error ? err.message : String(err),
    });
    // Surface a critical notification so TaskCanvas shows actionable copy
    // alongside the failure pill. addNotification merges into error.notifications,
    // preserving the markFailedStep payload above.
    if (err instanceof ToolTimeoutError) {
      await dispatchNotificationStep(runId, 'request_timeout', {
        description: `${err.toolName} did not respond within ${Math.round(err.timeoutMs / 1000)}s.`,
      });
    } else if (isRateLimitError(err)) {
      await dispatchNotificationStep(runId, 'request_timeout', {
        title: 'Rate limit reached',
        description:
          'The model API is throttling requests. Wait a moment and retry, or skip this step.',
      });
    }
    // Re-throw so the workflow itself is marked failed in WDK's run record.
    throw err;
  }
}
