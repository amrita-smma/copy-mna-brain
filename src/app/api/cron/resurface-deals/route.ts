import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Scheduled deal-resurface cron route.
 *
 * - Fires hourly (configured in vercel.json crons).
 * - Sweeps dropped companies whose `resurface_at` has passed: each is put
 *   back to `active`, gets a deal note explaining the automatic resurface
 *   (including the original drop reason), and the PIC + the user who dropped
 *   the deal are emailed via the `send-email` queue.
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
    const { dealResurfaceService } = createContainer(db);
    const result = await dealResurfaceService.processDue();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'resurface sweep failed';
    console.error('[cron/resurface-deals] failed:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
