import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { getActiveWorkspaceId } from '@/lib/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The pulse makes one LLM call on generation; give it room under the 60s cap.
export const maxDuration = 60;

/**
 * Scheduled "Today's Recap" generation.
 *
 * - Fires daily at 00:00 UTC (configured in vercel.json crons), the same UTC
 *   day boundary the pulse is keyed on, so the fresh day's recap is precomputed
 *   and every dashboard load that day reads it from the `daily_pulse` table
 *   instead of paying the compute + LLM cost.
 * - `generatePulse` runs unconditionally and is idempotent — it upserts the
 *   day's row, so a re-run just refreshes the same day.
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
    const { dailyPulseService } = createContainer(db, await getActiveWorkspaceId());
    const pulse = await dailyPulseService.generatePulse();
    return NextResponse.json({ ok: true, date: pulse.date });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'daily-pulse generation failed';
    console.error('[cron/daily-pulse] failed:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
