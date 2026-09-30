import { FatalError, RetryableError, getStepMetadata } from 'workflow';
import { NO_ACTIVE_WORKSPACE_ID } from '@/lib/constants';
import { runWithWorkforceWorkspaceId } from '@/lib/workspace';
import {
  extractMessageText,
  getWorkforceAgentGraphForEffort,
  HumanMessage,
  type EffortChoice,
} from '@/lib/agents/analysis';
import type { SectorAgentKey } from '@/lib/agents/sector/registry';
import { ToolTimeoutError } from '@/lib/agents/withToolTimeout';
import {
  AiWorkforceQueueRepository,
  InsightRepository,
  InsightRunDraftRepository,
  InsightVersionRepository,
  RoutinesRepository,
  UserRepository,
  UserWorkspaceRepository,
  WorkspaceRepository,
} from '@/lib/repositories';
import {
  InsightService,
  InsightRunPublishError,
  type PublishRunDraftResult,
} from '@/lib/services/insightService';
import { EmailNotificationService } from '@/lib/services/emailNotificationService';
import { NotificationService } from '@/lib/services/notificationService';
import { InterventionRecipientService } from '@/lib/services/interventionRecipientService';
import type { NotificationKind } from '@/lib/notifications/types';
import { createDb } from '@/lib/server/db';
import { asWorkforceEffort } from '@/lib/chat/effortTiers';
import { ChatAttachmentService, type ChatAttachmentRef } from '@/lib/services/chatAttachmentService';
import { resolveInsightAgentStamp } from '@/lib/insights/agentStamp';
import { readRefreshInsightId, readRunAgentKey } from '@/lib/routines/refreshAgent';
import { failAiOpinionIfStillProcessing } from './clearAiOpinionOnFailure';
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

function isGraphRecursionError(err: unknown): boolean {
  if (
    err instanceof Error &&
    (err.name === 'GraphRecursionError' ||
      /recursion limit/i.test(err.message))
  ) {
    return true;
  }
  return false;
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
  // The row's own workspace_id. There is no session here to resolve it from
  // (this runs as a durable workflow step, not an HTTP request), so every
  // downstream step that needs workspace scoping — agent tool calls via
  // runWithWorkforceWorkspaceId, and the notifier's RoutinesRepository —
  // takes it as an explicit parameter threaded from here rather than calling
  // getActiveWorkspaceId(), which would silently resolve to MnA.
  workspaceId: string;
  effort: EffortChoice;
  /** Email of triggered_by_user_id, when resolvable — for omit-to send_email. */
  userEmail: string | null;
  /** Queue row agent_name — used to gate AI Opinion spinner clearing. */
  agentName: string;
  /** Queue row trigger_meta — entity ids for AI Opinion spinner clearing. */
  triggerMeta: unknown;
  triggered_by_user_id: string | null;
  attachments?: ChatAttachmentRef[];
  originRoutineId: string | null;
  refreshInsightId: string | null;
  /**
   * The sector agent a refresh run runs on, from the row's `input.agent_key`
   * (resolved when the run was created — MB-560). Null for the general
   * workforce agent, and always null for a non-refresh run.
   */
  agentKey: SectorAgentKey | null;
}

async function loadAndHeartbeat(runId: string): Promise<LoadResult> {
  'use step';
  const db = createDb();
  const repo = new AiWorkforceQueueRepository(db, NO_ACTIVE_WORKSPACE_ID);

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

  // Resolve the effort tier. Prefer the current `input.effort` field; fall
  // back to the legacy `input.model` ('opus' | 'sonnet') for any queue row
  // enqueued before the effort rename so in-flight/historical rows still run.
  // Allow 'deep' through for workforce; floor 'low' to 'medium'.
  const rawEffort = input.effort ?? (input.model === 'opus' ? 'high' : input.model);
  const effort: EffortChoice = asWorkforceEffort(rawEffort);

  // Read-and-clear buffered updates atomically; if the consume step fails
  // mid-run, WDK retries the whole step — since the consume is wrapped in
  // its own transaction, the buffer is either fully drained or untouched.
  const pending = await repo.consumePendingUserMessages(runId);

  await repo.heartbeat(runId);

  let userEmail: string | null = null;
  const triggered_by_user_id = row.triggered_by_user_id ?? null;
  if (row.triggered_by_user_id) {
    try {
      const user = await new UserRepository(db).findById(row.triggered_by_user_id);
      const email = user?.email?.trim();
      if (email) userEmail = email;
    } catch (err) {
      console.warn('[runAgent] failed to resolve triggered_by user email', err);
    }
  }

  const attachments = Array.isArray(input.attachments)
    ? (input.attachments as ChatAttachmentRef[])
    : undefined;

  const originRoutineId = row.origin_routine_id ?? null;
  // A routine's run, or a one-off refresh a CoPilot card queued (MB-552).
  const refreshInsightId = readRefreshInsightId({
    origin_routine_id: originRoutineId,
    trigger_meta: row.trigger_meta,
    input,
  });
  // Only a refresh run picks its agent; every other run stays on the general
  // workforce agent, as before.
  const agentKey = refreshInsightId ? readRunAgentKey(input) : null;

  return {
    prompt: candidate,
    resumePayloadJson: row.resume_token ?? null,
    threadId,
    pendingMessages: pending.map((m) => m.text),
    workspaceId: row.workspace_id,
    effort,
    userEmail,
    agentName: row.agent_name,
    triggerMeta: row.trigger_meta,
    triggered_by_user_id,
    attachments,
    originRoutineId,
    refreshInsightId,
    agentKey,
  };
}

export type InvokeStepResult =
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
    }
  | {
      kind: 'failed';
      reason: string;
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

/** Final-message prefix AnalysisAgent.invoke returns when the model call threw. */
const AGENT_INVOKE_ERROR_PREFIX = 'Error invoking agent:';

export async function invokeAgent(
  runId: string,
  prompt: string,
  resumePayloadJson: string | null,
  threadId: string,
  pendingMessages: string[],
  workspaceId: string,
  effort: EffortChoice,
  userEmail: string | null,
  triggered_by_user_id: string | null = null,
  attachments?: ChatAttachmentRef[],
  refresh: {
    originRoutineId: string | null;
    refreshInsightId: string | null;
    agentKey?: SectorAgentKey | null;
  } = {
    originRoutineId: null,
    refreshInsightId: null,
  },
): Promise<InvokeStepResult> {
  'use step';
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new FatalError('ANTHROPIC_API_KEY is not set');
  }

  // 1-based: the first attempt is 1. Only defined inside a WDK step; default to 1
  // so this can never throw.
  let attempt = 1;
  try {
    attempt = getStepMetadata().attempt ?? 1;
  } catch {
    // not running under WDK (e.g. unit tests without the compiler)
  }
  const isRetryAttempt = attempt > 1;

  // A refresh run on a bound insight runs on its sector agent's workforce
  // graph (MB-560); everything else on the general workforce graph. Both share
  // the checkpointer, and the key comes from the row, so a resume after a HITL
  // pause rebuilds the same graph the run started on.
  //
  // The sector stack is imported lazily, here in the step body. A static
  // import would close an import cycle: analysis/tools → @/lib/workforce →
  // dispatcher → workflowTrigger → runAgent → sector/graph → <agent>/tools →
  // sector/coreTools, which spreads the analysis tool list while it is still
  // being evaluated (SERVER_TOOLS undefined → "not iterable"). Inside the step
  // body it is also stripped from the workflow bundle with the step.
  const agentKey = refresh.agentKey ?? null;
  const graph = agentKey
    ? await (await import('@/lib/agents/sector/graph')).getSectorAgentGraph(
        agentKey,
        'workforce',
        effort,
      )
    : await getWorkforceAgentGraphForEffort(effort);
  if (!graph) {
    // Returns null on initialization failure (logs the cause). Surface as
    // retryable in case it was a transient DB blip during
    // PostgresSaver.setup().
    throw new RetryableError(
      agentKey
        ? `sector agent graph unavailable (${agentKey})`
        : 'workforce agent graph unavailable',
    );
  }

  const toolConfig = {
    thread_id: threadId,
    agentRole: 'workforce' as const,
    // The run's files, so send_email's `attached_html` can send an uploaded
    // HTML document as-is here too — a handed-off file keeps that ability.
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    ...(userEmail ? { userEmail } : {}),
    triggered_by_user_id: triggered_by_user_id ?? null,
    run_id: runId,
    origin_routine_id: refresh.originRoutineId,
    refresh_insight_id: refresh.refreshInsightId,
    // Read by the insight tools' readConfiguredAgentStamp (MB-549). Only set
    // for a sector run; a general run stamps nothing, as before.
    ...(agentKey ? { agent_key: agentKey } : {}),
  };

  // A prior run's attachments were uploaded to Anthropic's Files API and
  // deleted when that run finished, but the checkpoint still holds the
  // `{type:'file', fileId}` blocks that referenced them. Replaying the thread
  // would 404, so repoint them at this run's fresh uploads (or neutralize them
  // when nothing is attached) before the graph sees the history. Also close
  // tool_calls orphaned by a run that died mid-tool — Anthropic rejects the
  // next turn otherwise. Both mirror what /api/chat does per turn; a reopened
  // or resumed workforce run is the same situation. A same-run WDK retry after
  // a mid-tool timeout is the same situation — the killed attempt left
  // `tool_calls` with no results in the checkpoint.
  const isResumedThread = threadId !== runId;
  if (isResumedThread || resumePayloadJson || isRetryAttempt) {
    try {
      await graph.rewriteFileReferences(threadId, []);
      await graph.repairOrphanedToolCalls(threadId);
    } catch (err) {
      console.warn('[runAgent] thread repair failed; continuing', err);
    }
  }

  // Keep the queue heartbeat alive during long tool calls (e.g. pptx skill).
  const heartbeatTimer = setInterval(() => {
    void (async () => {
      try {
        const db = createDb();
        const repo = new AiWorkforceQueueRepository(db, workspaceId);
        await repo.heartbeat(runId);
      } catch (err) {
        console.warn('[runAgent] mid-invoke heartbeat failed', err);
      }
    })();
  }, 60_000);

  const chatAttachmentService = new ChatAttachmentService(workspaceId);
  let uploadedFileIds: string[] = [];

  // Agent tools call getActiveWorkspaceId() the same way request-handling
  // code does, but there's no session here to resolve it from. Wrapping the
  // whole invoke (and any tool calls LangGraph makes inside it) in this
  // context makes the seam resolve to the row's real workspace instead of
  // silently falling back to MnA. Verified this survives through
  // LangChain's tool() wrapper and an async DB-call hop, not just a bare
  // promise chain.
  try {
    const result = await runWithWorkforceWorkspaceId(workspaceId, async () => {
      if (resumePayloadJson) {
        return graph.resume(runId, JSON.parse(resumePayloadJson), {
          configurable: toolConfig,
          recursionLimit: 50,
        });
      }
      const state = (await graph.getState({
        configurable: { thread_id: threadId },
      })) as { values?: { messages?: unknown[] } };
      const isReopen = state.values?.messages && state.values.messages.length > 0;

      let firstMessage: HumanMessage;
      if (!isReopen && attachments && attachments.length > 0) {
        // 'full': the Workforce builds section by section and must read a
        // large HTML file whole; chat gets an outline of it instead.
        const { blocks, fileIds } = await chatAttachmentService.prepareForMessage(attachments, {
          largeHtml: 'full',
        });
        uploadedFileIds = fileIds;
        firstMessage = new HumanMessage({
          content: [
            {
              type: 'text',
              text: prompt || 'Please review the attached file(s).',
            },
            ...blocks,
          ],
        });
      } else {
        firstMessage = new HumanMessage(prompt);
      }

      return graph.invoke(
        {
          messages: isReopen
            ? pendingMessages.map((t) => new HumanMessage(t))
            : [
                firstMessage,
                ...pendingMessages.map((t) => new HumanMessage(t)),
              ],
        },
        { configurable: toolConfig, recursionLimit: 50 },
      );
    });

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
      finalResult = await runWithWorkforceWorkspaceId(workspaceId, () =>
        graph.invoke(
          { messages: pendingMessages.map((t) => new HumanMessage(t)) },
          { configurable: toolConfig, recursionLimit: 50 },
        ),
      );
      if (finalResult.interrupt?.actionRequests?.length) {
        return interruptedFrom(finalResult.interrupt.actionRequests[0]);
      }
    }

    const messages = finalResult.messages ?? [];
    const lastMessage = messages[messages.length - 1];
    const finalMessage = extractMessageText(lastMessage);

    let isFailure = finalMessage.trim().startsWith('✗ Could not complete');
    let failureReason = finalMessage;

    // AnalysisAgent.invoke catches a provider error (e.g. an exhausted credit
    // balance) and returns it as the final message instead of throwing. Left
    // alone the run would succeed, and a refresh run would then record an
    // "unchanged" version for a refresh that never ran.
    if (!isFailure && finalMessage.trim().startsWith(AGENT_INVOKE_ERROR_PREFIX)) {
      isFailure = true;
    }

    if (!isFailure && lastMessage) {
      const toolCalls = (lastMessage as unknown as { tool_calls?: unknown[] }).tool_calls;
      if (Array.isArray(toolCalls)) {
        const narrate = (toolCalls as any[]).find((tc) => tc?.name === 'narrate_step');
        if (narrate && narrate.args && typeof narrate.args === 'object') {
          const title = narrate.args.title;
          if (typeof title === 'string' && /^[✗✘]/.test(title.trim())) {
            isFailure = true;
            // Use the overview if available to provide more context in the error,
            // otherwise fallback to the title.
            const overview = narrate.args.overview;
            failureReason = typeof overview === 'string' ? `${title}\n\n${overview}` : title;
          }
        }
      }
    }

    // Empty final messages (e.g. unparsed invalid_tool_calls or thinking-only
    // turns) indicate an incomplete run rather than a completed one. Fail the run
    // so the user is prompted to retry rather than reporting false success.
    if (!isFailure && lastMessage && finalMessage.trim() === '') {
      const invalid = (
        lastMessage as unknown as { invalid_tool_calls?: unknown[] }
      ).invalid_tool_calls;
      isFailure = true;
      if (Array.isArray(invalid) && invalid.length > 0) {
        // The SDK leaves `name` empty when the tool call arrives without the
        // frame that carries it, so this is frequently '<unnamed>'.
        const names = invalid
          .map((call) => {
            const name = (call as { name?: unknown }).name;
            return typeof name === 'string' && name.trim() ? name : '<unnamed>';
          })
          .join(', ');
        const sdkError = invalid
          .map((call) => (call as { error?: unknown }).error)
          .find((err): err is string => typeof err === 'string' && err.length > 0);
        failureReason =
          `The run ended on a tool call that could not be parsed (${names}` +
          `${sdkError ? `: ${sdkError}` : ''}), so the agent stopped before ` +
          `producing any output. Nothing was saved — retry the task.`;
      } else {
        failureReason =
          'The run ended without producing any output — the agent stopped before ' +
          'writing a final message. Nothing was saved — retry the task.';
      }
    }

    if (isFailure) {
      return {
        kind: 'failed',
        reason: failureReason,
      };
    }

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
  } catch (err) {
    if (isGraphRecursionError(err)) {
      return {
        kind: 'failed',
        reason: 'Run hit the step limit (recursion limit of 50 reached without completing)',
      };
    }
    throw err;
  } finally {
    clearInterval(heartbeatTimer);
    if (uploadedFileIds.length > 0) {
      const idsToDelete = uploadedFileIds;
      uploadedFileIds = [];
      await chatAttachmentService.deleteFromAnthropic(idsToDelete);
    }
  }
}

// WDK retries a step 3 times by default (4 attempts), and a platform timeout
// counts as an attempt: the queue redelivers the killed step and `attempt`
// increments. Each attempt is capped at 800s (`maxDuration: "max"` on
// Pro/Enterprise), and a retry continues from the thread's last checkpoint
// rather than restarting the task. 5 retries = 6 attempts ≈ 80 minutes of agent
// time, and — because every attempt's graph.invoke gets its own
// recursionLimit of 50 — at most ~300 supersteps. The longest real run seen was
// ~44 minutes.
invokeAgent.maxRetries = 5;

async function finalize(
  runId: string,
  result: Extract<InvokeStepResult, { kind: 'completed' }>,
  workspaceId: string,
  agentName: string,
  triggerMeta: unknown,
  refreshInsightId: string | null = null,
  agentKey: SectorAgentKey | null = null,
): Promise<{ kind: 'ok' } | { kind: 'publish_refused'; reason: string }> {
  'use step';
  const db = createDb();
  let publishResult: PublishRunDraftResult | null = null;
  if (refreshInsightId) {
    // Why publish is before markSucceeded: a failed or unfinished run must publish
    // nothing; a retry after publish is a no-op because publishRunDraft is idempotent.
    const insightService = new InsightService(
      new InsightRepository(db),
      new InsightVersionRepository(db),
      new InsightRunDraftRepository(db),
      db,
    );
    try {
      // Stamp the agent that ran (the run's own key), not whatever the
      // insight is bound to now — a rebind mid-run applies from the next run.
      // Covers the unchanged-marker version too. General → null, as before.
      publishResult = await insightService.publishRunDraft(
        workspaceId,
        runId,
        refreshInsightId,
        resolveInsightAgentStamp(agentKey),
      );
    } catch (err) {
      if (err instanceof InsightRunPublishError) {
        return { kind: 'publish_refused', reason: err.message };
      }
      throw err;
    }
  }

  const repo = new AiWorkforceQueueRepository(db, workspaceId);
  await repo.clearResumeToken(runId);
  await repo.markSucceeded(runId, {
    final_message: result.finalMessage,
    message_count: result.messageCount,
    tool_call_count: result.toolCallCount,
  });
  // AI Opinion runs that finish without calling save_*_ai_opinion would
  // otherwise leave the entity spinner stuck on 'processing' forever.
  // agentName/triggerMeta come from loadAndHeartbeat — no extra findById.
  await failAiOpinionIfStillProcessing(db, workspaceId, triggerMeta, agentName);
  await kickDispatcher(db);
  // Best-effort completion notification (MB-90). Skips cron runs internally —
  // those roll up into the routine digest instead.
  await makeNotifier(db, workspaceId).notifyTaskCompleted(runId);

  // Only a refresh that changed the insight notifies. 'unchanged' recorded an
  // is_unchanged version and stays silent; 'already_published' is a retry
  // that already notified (or deliberately didn't) on its first pass.
  if (publishResult?.status === 'published') {
    await makeNotifier(db, workspaceId).notifyInsightRefreshed({
      workspaceId,
      insightId: publishResult.insightId,
      insightName: publishResult.insightName,
      versionNo: publishResult.versionNo,
      ownerUserId: publishResult.ownerUserId,
    });
  }

  return { kind: 'ok' };
}

async function markWaitingStep(
  runId: string,
  reason: string,
  workspaceId: string,
  toolName: string | undefined,
  toolArgs: Record<string, unknown> | undefined,
  run: {
    triggeredByUserId: string | null;
    originRoutineId: string | null;
    refreshInsightId: string | null;
  },
): Promise<void> {
  'use step';
  const db = createDb();
  const repo = new AiWorkforceQueueRepository(db, workspaceId);
  // Who is asked: the insight owner for a refresh run, else the triggerer
  // (see InterventionRecipientService). Recorded on the row regardless of the
  // email flag — a cron run has no triggerer, so this is what lets anyone
  // decide it at all.
  const askedUserId = await new InterventionRecipientService(
    new InsightRepository(db),
    new RoutinesRepository(db, workspaceId),
    new UserWorkspaceRepository(db),
  ).resolveRecipient(
    {
      workspace_id: workspaceId,
      triggered_by_user_id: run.triggeredByUserId,
      origin_routine_id: run.originRoutineId,
    },
    run.refreshInsightId,
  );
  await repo.clearResumeToken(runId);
  await repo.markWaitingForHumanInput(runId, reason, {
    tool_name: toolName ?? '',
    tool_args: toolArgs ?? {},
    asked_user_id: askedUserId,
    asked_at: new Date().toISOString(),
  });
  await kickDispatcher(db);
  // The reason is the human-readable fallback; toolName/toolArgs let the email
  // render the structured proposal card (e.g. promote_to_l1 → L0→L1).
  await makeNotifier(db, workspaceId).notifyTaskWaitingApproval(runId, {
    action: reason,
    toolName,
    toolArgs,
    recipientUserId: askedUserId,
  });
}

async function markFailedStep(
  runId: string,
  errorPayload: Record<string, unknown>,
  workspaceId: string,
  agentName: string,
  triggerMeta: unknown,
): Promise<void> {
  'use step';
  const db = createDb();
  const repo = new AiWorkforceQueueRepository(db, workspaceId);
  await repo.clearResumeToken(runId);
  await repo.markFailed(runId, errorPayload);
  await failAiOpinionIfStillProcessing(db, workspaceId, triggerMeta, agentName);
  await kickDispatcher(db);
  const reason =
    typeof errorPayload.message === 'string' ? errorPayload.message : undefined;
  await makeNotifier(db, workspaceId).notifyTaskFailed(runId, { cancelled: false, reason });
}

// Build an EmailNotificationService bound to this step's db. Notifications are
// best-effort — the service swallows its own errors, so this never throws into
// the workflow. workspaceId comes from the queue row itself (threaded from
// loadAndHeartbeat) — RoutinesRepository.findById is workspace-scoped, so a
// run originating from a routine in a non-MnA workspace would otherwise
// silently fail to resolve the routine's context in the notification.
function makeNotifier(db: ReturnType<typeof createDb>, workspaceId: string): EmailNotificationService {
  return new EmailNotificationService({
    workforceRepo: new AiWorkforceQueueRepository(db, workspaceId),
    routinesRepo: new RoutinesRepository(db, workspaceId),
    userRepo: new UserRepository(db),
    workspaceRepo: new WorkspaceRepository(db),
  });
}

// Appended via the dispatcher's read-modify-write on error.notifications, so
// it merges with — and does not clobber — the markFailedStep payload above.
async function dispatchNotificationStep(
  runId: string,
  kind: NotificationKind,
  workspaceId: string,
  overrides: { title?: string; description?: string } = {},
): Promise<void> {
  'use step';
  const db = createDb();
  const repo = new AiWorkforceQueueRepository(db, workspaceId);
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

// A failure in (or before) loadAndHeartbeat leaves the row claimed but with no
// workflow attached. We have no workspaceId/agentName/triggerMeta here — those
// are what step 1 returns — so this uses the placeholder scope the reaper uses
// (hasRunning/claimNextRunnable/findStuckRunning are deliberately
// workspace-agnostic) and re-reads the row to decide whether it is ours to fail.
async function markFailedPreload(
  runId: string,
  errorPayload: Record<string, unknown>,
): Promise<void> {
  'use step';
  const db = createDb();
  const repo = new AiWorkforceQueueRepository(db, NO_ACTIVE_WORKSPACE_ID);
  const row = await repo.findById(runId);
  // Row gone, or not ours: loadAndHeartbeat throws FatalError when status is
  // not 'running', which is the double-start guard — a second start() firing
  // for a row another workflow legitimately owns. markFailed has NO status
  // precondition (updateStatusOrThrow writes unconditionally), so failing here
  // would corrupt a healthy run. Only fail a row still sitting in 'running'.
  if (!row || row.status !== 'running') return;
  await repo.markFailed(runId, errorPayload);
  await kickDispatcher(db);
}

export async function runAgent({ runId }: { runId: string }): Promise<void> {
  'use workflow';
  let loaded: LoadResult;
  try {
    loaded = await loadAndHeartbeat(runId);
  } catch (err) {
    await markFailedPreload(runId, {
      code: 'agent_load_failed',
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;   // re-throw so WDK still records the workflow run as failed
  }
  const { prompt, resumePayloadJson, threadId, pendingMessages, workspaceId,
          effort, userEmail, agentName, triggerMeta, triggered_by_user_id,
          attachments, originRoutineId, refreshInsightId, agentKey } = loaded;

  // Mid-invoke heartbeats run inside invokeAgent (60s ticker) so long tool
  // calls such as pptx generation do not trip the 30m reaper.
  try {
    const result = await invokeAgent(
      runId,
      prompt,
      resumePayloadJson,
      threadId,
      pendingMessages,
      workspaceId,
      effort,
      userEmail,
      triggered_by_user_id,
      attachments,
      { originRoutineId, refreshInsightId, agentKey },
    );
    if (result.kind === 'interrupted') {
      // Healthy pause: HITL middleware caught a gated tool call. The decision
      // endpoint will re-enqueue the resume by writing status='resume_ready'.
      // Nothing publishes here: publishRunDraft only runs in finalize, after
      // the resumed run completes.
      await markWaitingStep(
        runId,
        result.reason,
        workspaceId,
        result.toolName,
        result.toolArgs,
        { triggeredByUserId: triggered_by_user_id, originRoutineId, refreshInsightId },
      );
      return;
    }
    if (result.kind === 'failed') {
      await markFailedStep(
        runId,
        {
          code: 'agent_execution_failed',
          message: result.reason,
        },
        workspaceId,
        agentName,
        triggerMeta,
      );
      return;
    }
    const finalResult = await finalize(
      runId,
      result,
      workspaceId,
      agentName,
      triggerMeta,
      refreshInsightId,
      agentKey,
    );
    if (finalResult.kind === 'publish_refused') {
      await markFailedStep(
        runId,
        {
          code: 'refresh_publish_refused',
          message: finalResult.reason,
        },
        workspaceId,
        agentName,
        triggerMeta,
      );
      return;
    }
  } catch (err) {
    // WDK has already exhausted step retries by the time we get here.
    // Persist a terminal failure so the reaper doesn't have to.
    await markFailedStep(
      runId,
      {
        code: 'agent_execution_failed',
        message: err instanceof Error ? err.message : String(err),
      },
      workspaceId,
      agentName,
      triggerMeta,
    );
    // Surface a critical notification so TaskCanvas shows actionable copy
    // alongside the failure pill. addNotification merges into error.notifications,
    // preserving the markFailedStep payload above.
    if (err instanceof ToolTimeoutError) {
      await dispatchNotificationStep(runId, 'request_timeout', workspaceId, {
        description: `${err.toolName} did not respond within ${Math.round(err.timeoutMs / 1000)}s.`,
      });
    } else if (isRateLimitError(err)) {
      await dispatchNotificationStep(runId, 'request_timeout', workspaceId, {
        title: 'Rate limit reached',
        description:
          'The model API is throttling requests. Wait a moment and retry, or skip this step.',
      });
    }
    // Re-throw so the workflow itself is marked failed in WDK's run record.
    throw err;
  }
}
