import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import type { FeedFilter } from '@/lib/services/dashboardActivityService';

const VALID_FILTERS: FeedFilter[] = ['all', 'new_deal', 'stage_move', 'dropped', 'note_updated', 'ai_discovered'];
const DEFAULT_LIMIT = 15;
const MAX_LIMIT = 50;

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const fromParam = searchParams.get('from');
    const toParam = searchParams.get('to');

    if (!fromParam || !toParam) {
      return NextResponse.json({ error: 'from and to params are required' }, { status: 400 });
    }

    const from = new Date(fromParam);
    const to = new Date(toParam);

    if (isNaN(from.getTime()) || isNaN(to.getTime())) {
      return NextResponse.json({ error: 'Invalid date params' }, { status: 400 });
    }

    const offset = Math.max(0, Number(searchParams.get('offset')) || 0);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(searchParams.get('limit')) || DEFAULT_LIMIT),
    );

    const filterParam = searchParams.get('filter');
    const filter: FeedFilter =
      filterParam && VALID_FILTERS.includes(filterParam as FeedFilter)
        ? (filterParam as FeedFilter)
        : 'all';

    const db = createDb();
    const { dashboardActivityService } = createContainer(db, await getActiveWorkspaceId());
    const data = await dashboardActivityService.getFeed({ from, to, offset, limit, filter });

    return NextResponse.json({ data });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
