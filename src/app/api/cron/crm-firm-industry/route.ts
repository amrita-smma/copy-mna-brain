import { NextRequest, NextResponse } from 'next/server';
import { createContainer } from '@/lib/services/container';
import { cronUnauthorized, sweepWorkspaces } from '@/lib/server/cron';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// The labelling jobs run in `after()` within this budget.
export const maxDuration = 300;

/**
 * Hourly CRM firm industry: label the Industry of firms ingest created
 * without one.
 *
 * - Runs across EVERY live workspace (Vercel Cron carries no session). Each is
 *   `FirmIndustryService.classifyUnlabelledFirms`: one claim query for that
 *   workspace's unlabelled firms, then one job that labels them in a few
 *   model calls. The backlog drains a capped batch per workspace per hour.
 * - Idempotent: a claimed firm is stamped, so an overlapping sweep or the next
 *   workspace skips it, and a firm the model could not place waits out the
 *   retry window.
 *
 * Protected by CRON_SECRET (`cronUnauthorized`).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const unauthorized = cronUnauthorized(req);
  if (unauthorized) return unauthorized;

  try {
    let claimed = 0;
    const { workspaces, failedWorkspaces } = await sweepWorkspaces(
      'cron/crm-firm-industry',
      async (workspaceId, db) => {
        const { firmIndustryService } = createContainer(db, workspaceId);
        claimed += (await firmIndustryService.classifyUnlabelledFirms()).claimed;
      },
    );

    return NextResponse.json({
      ok: true,
      workspaces,
      claimed,
      ...(failedWorkspaces.length ? { failedWorkspaces } : {}),
    });
  } catch (err) {
    console.error('[cron/crm-firm-industry] failed:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
