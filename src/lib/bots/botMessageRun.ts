/**
 * Start a bot's background turn: insert its `jobs` row (the audit trail, as
 * every async job has) and start the `botMessageWorkflow` run. Called only by
 * `POST /api/internal/bot-messages` — the route one bot messages another
 * through (`sendBotMessage`) — so the turn starts in that route's own
 * invocation, never nested in the caller's. (The old `after()` path nested
 * A → B → A inside one 600 s chat invocation and died on Vercel.)
 *
 * WDK discovers the workflow by following `start()` calls statically reachable
 * from the app's routes, which is why the route imports this module directly.
 * A discovery miss surfaces as `start()` throwing, which fails the job row and
 * rethrows to the route (a 500 to the sender).
 */
import { start } from 'workflow/api';
import { JobRepository, type DbClient, type Tables } from '@/lib/repositories';
import type { BotMessageJob } from '@/lib/services/botService';
import { botMessageWorkflow } from './botMessageWorkflow';

/** The `jobs.type` a turn is audited under, by what started it. */
export function botJobType(origin: BotMessageJob['origin']): Tables<'jobs'>['type'] {
  if (origin.kind === 'routine') return 'bot_routine';
  if (origin.kind === 'bot_reply') return 'bot_reply';
  return 'bot_message';
}

export async function startBotMessageRun(input: {
  db: DbClient;
  workspaceId: string;
  job: BotMessageJob;
}): Promise<{ jobId: string; runId: string }> {
  const { db, workspaceId, job } = input;
  // Lazy: the handler imports the agent runtime, whose tools build the container.
  const { BOT_MESSAGE_TIMEOUT_SECONDS } = await import('@/lib/jobs/handlers/botMessage');
  const jobs = new JobRepository(db);
  const row = await jobs.create({
    type: botJobType(job.origin),
    payload: { ...job } as Tables<'jobs'>['payload'],
    timeout_seconds: BOT_MESSAGE_TIMEOUT_SECONDS,
    workspace_id: workspaceId,
  });
  try {
    const run = await start(botMessageWorkflow, [{ ...job, jobId: row.id, workspaceId }]);
    // One line per hop, so a deployment's logs show where a chain stops.
    console.log(`[bot-message] started run ${run.runId} for job ${row.id} (${row.type} → bot ${job.toBotId}, ${job.origin.kind})`);
    return { jobId: row.id, runId: run.runId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await jobs
      .markFailed(row.id, `could not start the workflow run: ${message}`)
      .catch((markErr: unknown) => console.error(`[bot-message] failed to mark job ${row.id} failed:`, markErr));
    throw err;
  }
}
