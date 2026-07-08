import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

/**
 * GET /api/crm/banker-related-companies
 *
 * Bankers (employers) ranked by the number of distinct related companies
 * attached to each, most first. Optional `?limit=N` caps the result (the
 * dashboard card requests a small top-N; the full page omits it).
 */
export async function GET(req: NextRequest) {
  try {
    const limitParam = req.nextUrl.searchParams.get('limit');
    const limit = limitParam != null ? Number(limitParam) : undefined;
    if (limit != null && (!Number.isFinite(limit) || limit < 0)) {
      return NextResponse.json({ error: 'Invalid limit param' }, { status: 400 });
    }

    const db = createDb();
    const { crmService } = createContainer(db, await getActiveWorkspaceId());
    const ranked = await crmService.getBankersByRelatedCompanyCount();
    const data = limit != null ? ranked.slice(0, limit) : ranked;

    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
