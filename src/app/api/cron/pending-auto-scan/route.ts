import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { drainPendingAutoScanQueue } from '@/lib/jobs/pendingAutoScanQueue';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The claimed scans run in this invocation's `after()`; each job's own timeout
// (PENDING_AUTO_SCAN_TIMEOUT_SECONDS) sits under this.
export const maxDuration = 600;

/**
 * Pending Confirmation auto-scan drain.
 *
 * - Fires every minute (configured in vercel.json crons).
 * - Claims the oldest companies queued by auto-scan (on arrival in Pending
 *   Confirmation) or the Scan now button, and starts one
 *   `pending_auto_scan` job per company.
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
    const result = await drainPendingAutoScanQueue(db);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'pending auto-scan drain failed';
    console.error('[cron/pending-auto-scan] failed:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
