import { FatalError, RetryableError } from 'workflow';
import {
  extractMessageText,
  getWorkforceAgentGraph,
  HumanMessage,
} from '@/lib/agents/analysis';
import { AiWorkforceQueueRepository } from '@/lib/repositories';
import { createDb } from '@/lib/server/db';
import { dispatcherTick } from './dispatcher';

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

  await repo.heartbeat(runId);
  return { prompt: candidate, resumePayloadJson: row.resume_token ?? null };
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
    };

async function invokeAgent(
  runId: string,
  prompt: string,
  resumePayloadJson: string | null,
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

  const result = resumePayloadJson
    ? await graph.resume(runId, JSON.parse(resumePayloadJson))
    : await graph.invoke(
        { messages: [new HumanMessage(prompt)] },
        { configurable: { thread_id: runId }, recursionLimit: 50 },
      );

  // HITL interrupt fired — the agent has paused awaiting a human decision.
  // Hand off to the decision endpoint via status; don't finalize and don't
  // throw (we'd rather not call markFailed for a healthy pause).
  if (result.interrupt?.actionRequests?.length) {
    const first = result.interrupt.actionRequests[0];
    const reason =
      typeof first.description === 'string' && first.description.trim()
        ? first.description
        : `Awaiting approval for ${first.name ?? 'tool call'}`;
    return { kind: 'interrupted', reason };
  }

  const messages = result.messages ?? [];
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
}

async function markWaitingStep(runId: string, reason: string): Promise<void> {
  'use step';
  const db = createDb();
  const repo = new AiWorkforceQueueRepository(db);
  await repo.clearResumeToken(runId);
  await repo.markWaitingForHumanInput(runId, reason);
  await kickDispatcher(db);
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
  const { prompt, resumePayloadJson } = await loadAndHeartbeat(runId);

  // TODO(Tier 3+): heartbeat periodically inside long invokeAgent runs so
  // legitimate slow LLM/tool work doesn't trip the reaper's 5min staleness
  // window. The single heartbeat in loadAndHeartbeat covers the no-op-fast
  // case; agents that run > ~4 min need a sidecar heartbeat loop or the
  // step itself needs to break into smaller turns.
  try {
    const result = await invokeAgent(runId, prompt, resumePayloadJson);
    if (result.kind === 'interrupted') {
      // Healthy pause: HITL middleware caught a gated tool call. The decision
      // endpoint will re-enqueue the resume by writing status='resume_ready'.
      await markWaitingStep(runId, result.reason);
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
    // Re-throw so the workflow itself is marked failed in WDK's run record.
    throw err;
  }
}
