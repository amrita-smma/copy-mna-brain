import { after } from 'next/server';
import { AiWorkforceQueueRepository } from '@/lib/repositories';
import type { DbClient } from '@/lib/repositories';
import { createDb } from '@/lib/server/db';
import { dispatcherTick } from './dispatcher';
import { generateWorkforceTitle } from './title';

export type TriggerSource = 'chat' | 'cron' | 'webhook' | 'api';

export interface EnqueueAgentRunInput {
  agentName: string;
  triggerSource: TriggerSource;
  triggerMeta?: Record<string, unknown>;
  input: Record<string, unknown>;
  priority?: number;
  parentRunId?: string | null;
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
  const queueRepo = new AiWorkforceQueueRepository(db);

  const { row, created } = await queueRepo.createOrGetByIdempotencyKey({
    agent_name: input.agentName,
    trigger_source: input.triggerSource,
    trigger_meta: input.triggerMeta ?? {},
    input: input.input,
    priority: input.priority ?? 0,
    parent_run_id: input.parentRunId ?? null,
    idempotency_key: input.idempotencyKey ?? null,
    triggered_by_user_id: input.triggeredByUserId ?? null,
  } as never);

  if (created) {
    scheduleDispatch();
    scheduleTitleGeneration(row.id, input.input);
  }

  return { runId: row.id, created };
}

/**
 * Fire-and-forget title generation. If `input.prompt` is a string, use Haiku
 * to produce a 2-6 word title and UPDATE the row. Best-effort: errors are
 * caught inside generateWorkforceTitle.
 *
 * Skipped when the prompt isn't a string (e.g. subagent dispatch passing
 * structured input, future trigger sources without prompts). The UI should
 * fall back to truncating input.prompt or the agent_name when title is null.
 */
function scheduleTitleGeneration(
  runId: string,
  input: Record<string, unknown>,
): void {
  const prompt = typeof input.prompt === 'string' ? input.prompt : undefined;
  if (!prompt) return;
  after(async () => {
    await generateWorkforceTitle(runId, prompt);
  });
}

/**
 * Fire-and-forget dispatcher trigger.
 *
 * Uses Next.js `after()` so it runs post-response without blocking the
 * caller. `after()` works in all request-scoped server contexts (route
 * handlers, server actions, middleware) — every Tier 1 caller is in one of
 * these. Future Tier 3 callers from inside a Vercel Workflow should `await`
 * the dispatcher directly instead, since the workflow won't be killed.
 *
 * We construct a fresh DbClient inside `after()` because the request's
 * connection may be released by the time the post-response phase runs.
 */
function scheduleDispatch(): void {
  after(async () => {
    try {
      const db = createDb();
      await dispatcherTick(db);
    } catch (err) {
      console.error('[enqueueAgentRun] dispatcher trigger failed:', err);
    }
  });
}
