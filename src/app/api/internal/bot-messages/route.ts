import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { JobRepository } from '@/lib/repositories';
import { checkInternalSecret } from '@/lib/server/internalApi';
import { botMessageRequestSchema } from '@/lib/bots/botMessageSchema';
import { BotMessageStartTimeoutError, startBotMessageRun } from '@/lib/bots/botMessageRun';
import { runWithWorkforceWorkspaceId } from '@/lib/workspace';
import type { BotMessageJob } from '@/lib/services/botService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * Room for the start's own deadline (`START_RUN_TIMEOUT_MS`, 15 s) and the
 * bookkeeping after it fails (the row, the asker's request). The platform
 * budget is the backstop, never the way a slow start is reported.
 */
export const maxDuration = 60;

/** The failure note the asker hears when the hand-off itself never started. */
export const NOT_STARTED_NOTE = 'The message could not be handed over (the turn never started).';

/**
 * One bot messaging another (`sendBotMessage`): which workspace, which user,
 * which bot, which text, how it came about, which request it answers. This is
 * the one place a bot's background turn is started — the `jobs` row is
 * inserted and the Workflow run begins here, in this invocation, so every
 * hand-off is a logged request plus an audit row, whoever sent it (the chat
 * route's `after()`, the dispatch cron, another bot's running turn).
 *
 * Internal: `X-Api-Secret: $ADMIN_SECRET`, the repo's machine-to-machine
 * credential (the data pipeline calls the smart-files route the same way).
 * `src/proxy.ts` gates `/api/internal/` on it; the check here is the second
 * line, and it fails closed without the secret.
 *
 * When the run cannot be started — `start()` throws, or hangs past its
 * deadline — the job row is already failed by `startBotMessageRun`; here the
 * bot request the message was answering (a `bot_mention`) is closed with a
 * note too, so the asker hears back now rather than from the request sweep
 * eleven minutes later, and the sender gets a 504 or 500 with the reason.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = checkInternalSecret(req.headers.get('x-api-secret'));
  if (auth !== 'ok') {
    if (auth === 'missing-secret') {
      console.error('[bot-messages] ADMIN_SECRET is not set on this deployment; refusing the internal call');
    }
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = botMessageRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid bot message', details: parsed.error.flatten() }, { status: 400 });
  }
  const { workspaceId, ...message } = parsed.data;
  const job = message as BotMessageJob;

  try {
    const db = createDb();
    const { jobId, runId } = await startBotMessageRun({ db, workspaceId, job });
    // The audit row: who handed this message over, and the run it became.
    await new JobRepository(db)
      .appendLog(jobId, {
        message: 'received over POST /api/internal/bot-messages',
        metadata: { origin: job.origin, requestId: job.requestId ?? null, runId },
      })
      .catch((err: unknown) => console.error(`[bot-messages] failed to log the hand-off on job ${jobId}:`, err));
    console.log(
      `[bot-messages] ${job.origin.kind} → bot ${job.toBotId} for user ${job.userId} (ws ${workspaceId}): job ${jobId}, run ${runId}`,
    );
    return NextResponse.json({ data: { jobId, runId } }, { status: 202 });
  } catch (err) {
    const timedOut = err instanceof BotMessageStartTimeoutError;
    console.error(
      `[bot-messages] failed to start the turn (${job.origin.kind} → bot ${job.toBotId}, ws ${workspaceId}${
        timedOut ? `, job ${err.jobId}` : ''
      }):`,
      err,
    );
    await closeRequestNotStarted(workspaceId, job);
    return timedOut
      ? NextResponse.json({ error: 'Timed out starting the turn' }, { status: 504 })
      : NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * Close the request this message was to answer, so the asker's reply turn
 * runs now with the failure instead of waiting for `sweepBotRequests`.
 * Best-effort: the sweep is still the backstop.
 */
async function closeRequestNotStarted(workspaceId: string, job: BotMessageJob): Promise<void> {
  const requestId = job.requestId;
  if (!requestId) return;
  try {
    // Lazy, and only on this path: the container is heavier than the route needs.
    const { createContainer } = await import('@/lib/services/container');
    const db = createDb();
    await runWithWorkforceWorkspaceId(workspaceId, () =>
      createContainer(db, workspaceId).botRequestService.close(requestId, { failure: NOT_STARTED_NOTE }),
    );
  } catch (closeErr) {
    console.error(`[bot-messages] failed to close request ${requestId} after the turn did not start:`, closeErr);
  }
}
