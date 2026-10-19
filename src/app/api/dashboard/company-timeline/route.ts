import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceId } from '@/lib/workspace';

/** Cap on one batch, so a crafted `ids` list can't turn into an unbounded scan. */
const MAX_IDS = 100;

/**
 * Activity timelines for several companies at once, keyed by company id.
 *
 * The sibling `[companyId]` route serves a single company. The dashboard feed
 * renders a carousel per company and used to call that route once per visible
 * card — this collapses a page of those into one request.
 */
export async function GET(req: NextRequest) {
  try {
    const idsParam = req.nextUrl.searchParams.get('ids');
    const ids = (idsParam ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    if (ids.length === 0) {
      return NextResponse.json({ error: 'ids is required' }, { status: 400 });
    }
    if (ids.length > MAX_IDS) {
      return NextResponse.json(
        { error: `ids accepts at most ${MAX_IDS} companies` },
        { status: 400 },
      );
    }

    const db = createDb();
    const { dashboardActivityService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dashboardActivityService.getCompanyTimelines(ids);

    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
