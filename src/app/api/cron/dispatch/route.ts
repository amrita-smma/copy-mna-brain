import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { dispatcherTick, reapStuckRuns } from '@/lib/workforce';
import { fireDueRoutines } from '@/lib/routines';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * AI Workforce queue dispatcher cron route.
 *
 * - Fires every minute (configured in vercel.json crons).
 * - Acts as the safety net for the reactive fire-and-forget dispatch path.
 *   Reactive triggers (after enqueueAgentRun, resolveMutation, etc.) handle
 *   the happy-path sub-second latency; this route catches dropped triggers
 *   within 60s.
 * - Also runs the reaper on each tick to mark stuck rows as failed and
 *   unblock the global-serial queue.
 * - Fires due routines on each tick: routines whose next_fire_at has passed
 *   are claimed under advisory lock and each enqueues a workforce run with
 *   trigger_source='cron'.
 *
 * Protected by CRON_SECRET; Vercel Cron sends `Authorization: Bearer
 * $CRON_SECRET`. When unset, the route is open (local dev only).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const db = createDb();
    const reapResult = await reapStuckRuns(db);
    // Fire routines BEFORE dispatcherTick so any routines firing this minute
    // can be picked up by the same tick's claim, avoiding an unnecessary
    // up-to-60s delay before the workflow starts.
    const fireResult = await fireDueRoutines(db);
    const dispatchResult = await dispatcherTick(db);
    return NextResponse.json({
      ok: true,
      reaper: reapResult,
      routines: fireResult,
      dispatch: dispatchResult,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'dispatch failed';
    console.error('[cron/dispatch] failed:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
