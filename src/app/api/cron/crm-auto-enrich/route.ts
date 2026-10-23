import { NextRequest, NextResponse } from 'next/server';
import { createContainer } from '@/lib/services/container';
import { cronUnauthorized, sweepWorkspaces } from '@/lib/server/cron';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Hourly CRM auto profile: Get Full Profile without a click for contacts who
 * just replied to the team for the first time.
 *
 * - Runs across EVERY live workspace (Vercel Cron carries no session). Each is
 *   `CrmContactEnrichmentService.enrichNewTwoWayContacts`: one candidate query,
 *   then at most `AUTO_ENRICH_PER_SWEEP` runs queued on the AI Workforce below
 *   user clicks. The research itself runs on the Workforce, not here.
 * - Idempotent: a contact with any earlier run in the workspace is never
 *   picked again, so a re-run queues nothing new.
 *
 * Protected by CRON_SECRET (`cronUnauthorized`).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const unauthorized = cronUnauthorized(req);
  if (unauthorized) return unauthorized;

  try {
    let queued = 0;
    const { workspaces, failedWorkspaces } = await sweepWorkspaces(
      'cron/crm-auto-enrich',
      async (workspaceId, db) => {
        const { crmContactEnrichmentService } = createContainer(db, workspaceId);
        queued += await crmContactEnrichmentService.enrichNewTwoWayContacts();
      },
    );

    return NextResponse.json({
      ok: true,
      workspaces,
      queued,
      ...(failedWorkspaces.length ? { failedWorkspaces } : {}),
    });
  } catch (err) {
    console.error('[cron/crm-auto-enrich] failed:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
