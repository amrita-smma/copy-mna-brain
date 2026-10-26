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
 * rethrows to the route (a 500 to the sender); a `start()` that hangs is cut
 * off at `START_RUN_TIMEOUT_MS` the same way (a 504).
 */
import { start } from 'workflow/api';
import { JobRepository, type DbClient, type Tables } from '@/lib/repositories';
import type { BotMessageJob } from '@/lib/services/botService';
import { BOT_MESSAGE_TIMEOUT_SECONDS } from './botMessageTimeout';
import { botMessageWorkflow } from './botMessageWorkflow';

/**
 * How long `start()` may take before the hand-off is given up on. The route
 * runs under Vercel's function budget (`maxDuration`), and a `start()` that
 * hangs past it is killed by the platform: no log line, the `jobs` row left
 * `pending` for nobody, the asker's request open until the sweep. Giving up
 * first turns that into a failed row with a note and a 504 the sender can
 * log. Shorter than `SEND_BOT_MESSAGE_TIMEOUT_MS` (the sender's wait), so the
 * sender hears the reason rather than its own abort.
 */
export const START_RUN_TIMEOUT_MS = 15_000;

/** `start()` did not return in time; the job row is already marked failed. */
export class BotMessageStartTimeoutError extends Error {
  constructor(readonly jobId: string) {
    super(`starting the workflow run timed out after ${START_RUN_TIMEOUT_MS / 1000}s`);
    this.name = 'BotMessageStartTimeoutError';
  }
}

/**
 * `start()`, bounded. A start that completes after the deadline still creates
 * a run, but its step finds the row failed, not pending, and leaves it alone
 * (`runBotMessageStep` claims atomically) — so the turn never runs twice and
 * never runs after the sender was told it failed.
 */
function startWithDeadline<T>(work: Promise<T>, jobId: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // If the deadline wins, `work` may still reject later; absorb it so Node
  // does not emit an unhandledrejection.
  void work.catch(() => {});
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BotMessageStartTimeoutError(jobId)), START_RUN_TIMEOUT_MS);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

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
  const jobs = new JobRepository(db);
  const row = await jobs.create({
    type: botJobType(job.origin),
    payload: { ...job } as Tables<'jobs'>['payload'],
    timeout_seconds: BOT_MESSAGE_TIMEOUT_SECONDS,
    workspace_id: workspaceId,
  });
  try {
    const run = await startWithDeadline(start(botMessageWorkflow, [{ ...job, jobId: row.id, workspaceId }]), row.id);
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
