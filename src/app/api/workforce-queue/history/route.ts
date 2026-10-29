import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { InvalidHistoryCursorError } from '@/lib/services/aiWorkforceService';

/**
 * One page of the AI Workforce rail's History: the workspace's finished runs,
 * newest-finished first. `cursor` is the previous page's `next_cursor`; `q`
 * filters by title; `limit` caps the page (the service clamps it).
 */
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const params = req.nextUrl.searchParams;
    const rawLimit = params.get('limit');
    const limit = rawLimit === null ? undefined : Number(rawLimit);
    if (limit !== undefined && !Number.isFinite(limit)) {
      return NextResponse.json({ error: 'limit must be a number' }, { status: 400 });
    }
    const db = createDb();
    const { aiWorkforceService } = createContainer(db, await getActiveWorkspaceId());
    const data = await aiWorkforceService.listHistory({
      cursor: params.get('cursor'),
      search: params.get('q'),
      limit,
    });
    return NextResponse.json({ data });
  } catch (err) {
    if (err instanceof InvalidHistoryCursorError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
