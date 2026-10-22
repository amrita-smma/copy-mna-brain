import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { JobRepository } from '@/lib/repositories';
import { checkInternalSecret } from '@/lib/server/internalApi';
import { botMessageRequestSchema } from '@/lib/bots/botMessageSchema';
import { startBotMessageRun } from '@/lib/bots/botMessageRun';
import type { BotMessageJob } from '@/lib/services/botService';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

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
    console.error('[bot-messages] failed to start the turn:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
