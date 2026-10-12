import { after } from 'next/server';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { AiWorkforceQueueRepository } from '@/lib/repositories';
import type { DbClient } from '@/lib/repositories';
import { createDb } from '@/lib/server/db';
import { dispatcherTick } from './dispatcher';
import { generateWorkforceTitle, persistWorkforceTitle, TITLE_MAX_CHARS } from './title';
import { runWithLangfuseUser } from '@/lib/langfuseUser';

export type TriggerSource = 'chat' | 'cron' | 'webhook' | 'api';

export interface EnqueueAgentRunInput {
  agentName: string;
  triggerSource: TriggerSource;
  triggerMeta?: Record<string, unknown>;
  input: Record<string, unknown>;
  priority?: number;
  parentRunId?: string | null;
  originRoutineId?: string | null;
  idempotencyKey?: string | null;
  // User who initiated the task. Required for chat/api triggers (UI shows
  // the owner); null for cron (use trigger_meta.routine_id to find creator)
  // and webhook (no human user).
  triggeredByUserId?: string | null;
}

export interface EnqueueAgentRunResult {
  runId: string;
  created: boolean;
}

/**
 * The single entrypoint for putting work on the AI Workforce queue.
 *
 * - Inserts one row in `ai_workforce_queue` with status='pending'.
 * - Handles idempotency: if `idempotencyKey` collides with an existing row,
 *   returns that row's id with `created: false` (no new row, no dispatch).
 * - Fires the dispatcher after the response is sent (via Next.js `after()`).
 *   The dispatcher's atomic claim ensures only one workflow starts even when
 *   the cron tick races us.
 *
 * Callers (chat route, webhook handler, cron-driven routine dispatcher, copilot
 * agent tool, future subagent dispatch) all funnel through here.
 */
export async function enqueueAgentRun(
  db: DbClient,
  input: EnqueueAgentRunInput,
): Promise<EnqueueAgentRunResult> {
  const workspaceId = await getActiveWorkspaceId();
  const queueRepo = new AiWorkforceQueueRepository(db, workspaceId);

  const { row, created } = await queueRepo.createOrGetByIdempotencyKey({
    agent_name: input.agentName,
    trigger_source: input.triggerSource,
    trigger_meta: input.triggerMeta ?? {},
    input: input.input,
    priority: input.priority ?? 0,
    parent_run_id: input.parentRunId ?? null,
    origin_routine_id: input.originRoutineId ?? null,
    idempotency_key: input.idempotencyKey ?? null,
    triggered_by_user_id: input.triggeredByUserId ?? null,
    // createOrGetByIdempotencyKey is deliberately unscoped (MB-147 surface —
    // idempotency lookups by key must see every workspace), so it doesn't
    // stamp this itself; the caller must supply a complete insert row.
    // Previously this object omitted workspace_id and was cast `as never`
    // to bypass the resulting type error — every insert violated the
    // NOT NULL constraint at runtime instead of failing at compile time.
    workspace_id: workspaceId,
  });

  if (created) {
    await scheduleDispatch();
    scheduleTitleGeneration(row.id, input.input, input.triggeredByUserId);
  }

  return { runId: row.id, created };
}

/**
 * Fire-and-forget title generation / persistence.
 *
 * If `input.title` is a non-empty string, persist it directly (trimmed,
 * truncated to TITLE_MAX_CHARS) via `after()` and skip the Haiku call entirely.
 *
 * Otherwise, fall back to Haiku generation on `input.prompt`. If neither is
 * present, do nothing.
 */
function scheduleTitleGeneration(
  runId: string,
  input: Record<string, unknown>,
  triggeredByUserId?: string | null,
): void {
  const rawTitle = typeof input.title === 'string' ? input.title.trim() : '';
  if (rawTitle) {
    after(async () => {
      await persistWorkforceTitle(runId, rawTitle.slice(0, TITLE_MAX_CHARS));
    });
    return;
  }

  const prompt = typeof input.prompt === 'string' ? input.prompt : undefined;
  if (!prompt) return;
  after(async () => {
    // Attributed to whoever enqueued the run, matching the run's own traces
    // (`runAgent` seeds the same `triggered_by_user_id`). The scope is opened
    // inside the `after` callback rather than inherited from the request: a
    // callback the platform invokes later is not on this request's async
    // chain. A cron or webhook enqueue has no user, and is a no-op here.
    await runWithLangfuseUser(triggeredByUserId, () =>
      generateWorkforceTitle(runId, prompt),
    );
  });
}

/**
 * Synchronous dispatcher trigger.
 *
 * Previously used Next.js `after()`, but this caused UX issues where manual
 * enqueues (e.g. from the UI) would see the new row as 'pending' because
 * the response was sent before the dispatcher claimed it. Awaiting this
 * directly adds minimal latency and guarantees the UI sees the
 * workflow as 'running' immediately if the queue was empty.
 */
async function scheduleDispatch(): Promise<void> {
  try {
    const db = createDb();
    await dispatcherTick(db);
  } catch (err) {
    console.error('[enqueueAgentRun] dispatcher trigger failed:', err);
  }
}
