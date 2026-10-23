import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { crmContactErrorResponse } from '../../errorResponse';
import { isInsightsPeriod, periodToSince } from '@/lib/crm/insightsPeriod';

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * One contact's insights: per team member emails each way and last email;
 * the contact's last contact and team size; the companies the person's own
 * emails were evidence for; deal links; and the deal scorecard, counting only
 * deals that entered Brain within `?period=` (`30d`, `90d`, `ytd`, `12m`;
 * default all time). 400 on an unknown period, 404 when the contact is not
 * visible in the active workspace.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    const { id } = await ctx.params;
    const period = req.nextUrl.searchParams.get('period') ?? 'all';
    if (!isInsightsPeriod(period)) {
      return NextResponse.json({ error: 'Invalid period' }, { status: 400 });
    }
    const since = periodToSince(period);
    const db = createDb();
    const { contactInsightsService } = createContainer(db, await getActiveWorkspaceId());
    const data = await contactInsightsService.getContactInsights(id, { since });
    return NextResponse.json({ data });
  } catch (err) {
    return crmContactErrorResponse(err, '[GET /api/crm/correspondents/:id/insights]');
  }
}
