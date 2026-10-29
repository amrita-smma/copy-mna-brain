import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';

/**
 * The CRM page's insights bar (stale firms, flagged records, emails today,
 * mailbox sync status). Split from GET /api/crm so the list — which refetches
 * on every debounced search keystroke and page change — does not re-run these
 * workspace-wide counts each time. The page loads this once on open and again
 * after a mutation that can move the numbers.
 */
export async function GET(req: NextRequest) {
  try {
    const clientTodayIsoStr = req.nextUrl.searchParams.get('clientTodayIso');
    const clientTodayIso =
      clientTodayIsoStr && !isNaN(Date.parse(clientTodayIsoStr))
        ? new Date(clientTodayIsoStr).toISOString()
        : undefined;
    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    const data = await crmService.insights({ clientTodayIso });
    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}
