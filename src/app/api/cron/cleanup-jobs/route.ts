import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { runSchedulerIfDue } from '@/lib/jobs/scheduler';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Trigger for the stuck-job cleanup sweep. Vercel Cron calls it hourly (see
 * vercel.json); it is also usable by hand for ops / debugging.
 *
 * Default behaviour honors the scheduler's 24h window, so the hourly cron
 * produces at most one sweep per day. Pass
 * `?force=true` to bypass the window and run the cleanup immediately;
 * useful when investigating incidents.
 *
 * Protected by CRON_SECRET; Vercel Cron sends `Authorization: Bearer
 * $CRON_SECRET`. When unset the route is open (local dev only).
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  const force = req.nextUrl.searchParams.get('force') === 'true';

  try {
    const db = createDb();
    if (force) {
      const { jobService } = createContainer(db, await getActiveWorkspaceId());
      const result = await jobService.cleanupStuckJobs();
      return NextResponse.json({ ran: true, forced: true, ...result });
    }
    const ran = await runSchedulerIfDue(db);
    return NextResponse.json({ ran, forced: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Cleanup failed';
    console.error('[cron] cleanup-jobs failed:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
