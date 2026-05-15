import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { dispatcherTick, reapStuckRuns } from '@/lib/workforce';

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
    const dispatchResult = await dispatcherTick(db);
    return NextResponse.json({
      ok: true,
      reaper: reapResult,
      dispatch: dispatchResult,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'dispatch failed';
    console.error('[cron/dispatch] failed:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
