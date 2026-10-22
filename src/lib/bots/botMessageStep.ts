/**
 * The one step of a bot's background turn (`botMessageWorkflow`): runs the
 * `bot_message` / `bot_reply` / `bot_routine` job in its own function
 * invocation, with the step's own `maxDuration` — never inside the request
 * that dispatched it.
 *
 * Idempotent against redelivery. WDK re-runs a step when its invocation dies
 * (a platform kill mid-turn, or a death after the body finished but before the
 * completion was recorded), and a delivery can be duplicated. The `jobs` row
 * is the arbiter, and every write to it is conditional:
 *   - `pending`  → claimed atomically (`claimPending`), the turn runs;
 *   - not pending on the first delivery → a duplicate of a live attempt, or
 *                  someone else already handled the row: leave it alone;
 *   - not pending on a retry → the previous attempt died. If the row is still
 *                  `running` it is failed (`failIfRunning`) and the bot request
 *                  it was answering is closed with that note, so the asker
 *                  still hears back — the turn is NOT re-run (a second reply
 *                  would be a duplicate). A row that finished is left alone.
 *
 * Only `'use step'` code imports the agent runtime: the handler and the job
 * runner are loaded lazily so the workflow bundle (which includes this file's
 * top-level imports) stays free of them. `createDb()` is the pooled client —
 * right for a long-lived step invocation; `withBackgroundDb` is for `after()`.
 *
 * Inside the step, the task-log summary still goes through `dispatchJob`'s
 * `after()`: that works only because WDK runs the step body inside the
 * `.well-known/workflow/v1/step` route's request scope.
 */
import { getStepMetadata } from 'workflow';
import { createDb } from '@/lib/server/db';
import { JobRepository } from '@/lib/repositories';
import type { BotMessageJob } from '@/lib/services/botService';
import { runWithWorkforceWorkspaceId } from '@/lib/workspace';

/** The bot-to-bot message: which user, which bot, which text — plus its audit row. */
export type BotMessageRunInput = BotMessageJob & { jobId: string; workspaceId: string };

/** The failure note a cut-off turn leaves on its job and on the request it answered. */
export const CUT_OFF_NOTE = 'The turn was cut off before it finished and was not re-run.';

/** Which delivery of this step this is (1 = first); 1 when not running under WDK. */
function stepAttempt(): number {
  try {
    return getStepMetadata().attempt ?? 1;
  } catch {
    return 1;
  }
}

export async function runBotMessageStep(input: BotMessageRunInput): Promise<{ ran: boolean }> {
  'use step';
  const { jobId, workspaceId, ...job } = input;
  const db = createDb();
  const jobs = new JobRepository(db);

  const attempt = stepAttempt();
  const claimed = await jobs.claimPending(jobId);
  console.log(
    `[bot-message] step attempt ${attempt} for job ${jobId} (${job.origin.kind} → bot ${job.toBotId}): ${claimed ? 'claimed, running the turn' : 'not pending'}`,
  );
  if (claimed) {
    const [{ runJob }, { BOT_MESSAGE_TIMEOUT_SECONDS, runBotMessage }] = await Promise.all([
      import('@/lib/jobs/runner'),
      import('@/lib/jobs/handlers/botMessage'),
    ]);
    // `runJob` never throws: it records completed / failed / timed_out on the
    // row (its own markRunning is a running→running no-op after the claim) and
    // flushes Langfuse.
    await runJob(jobs, jobId, BOT_MESSAGE_TIMEOUT_SECONDS * 1000, () =>
      runBotMessage({ db, workspaceId, ...job }),
    );
    const done = await jobs.findById(jobId).catch(() => null);
    console.log(`[bot-message] job ${jobId} finished as ${done?.status ?? 'unknown'}${done?.error ? `: ${done.error}` : ''}`);
    return { ran: true };
  }

  // Not pending. On the first delivery that is not ours to touch: a duplicate
  // delivery while the real attempt is still running, or a row someone else
  // already finished.
  if (attempt <= 1) return { ran: false };

  // A retry: the previous attempt died. Only a row it left `running` is ours
  // to fail; a finished row means it got there after all.
  const failed = await jobs.failIfRunning(jobId, CUT_OFF_NOTE).catch((err: unknown) => {
    console.error(`[bot-message] failed to mark job ${jobId} failed:`, err);
    return null;
  });
  if (!failed) return { ran: false };

  console.error(`[bot-message] job ${jobId} was cut off mid-turn by a previous attempt; failed it, not re-running`);
  const requestId = job.requestId;
  if (requestId) {
    try {
      // Lazy: the container pulls in the agent runtime.
      const { createContainer } = await import('@/lib/services/container');
      await runWithWorkforceWorkspaceId(workspaceId, () =>
        createContainer(db, workspaceId).botRequestService.close(requestId, { failure: CUT_OFF_NOTE }),
      );
    } catch (err) {
      console.error(`[bot-message] failed to close request ${requestId} after a cut-off turn:`, err);
    }
  }
  return { ran: false };
}
// One retry: `runJob` swallows the work's own errors, so a retry only means the
// platform killed the step; the branches above make it a clean failure.
runBotMessageStep.maxRetries = 1;
