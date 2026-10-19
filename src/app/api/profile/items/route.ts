import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { getSession } from '@/lib/server/session';

/**
 * The signed-in user's own items in the active workspace — the companies they
 * own, the insights they authored, and the decisions waiting on them.
 * `?limit=` caps each section (default 10, max 50).
 *
 * Always scoped to the session user: there is no `userId` param, so one member
 * cannot read another's queue.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const workspaceId = await getActiveWorkspaceId();
    if (!workspaceId) {
      return NextResponse.json({
        data: {
          companies: { items: [], total: 0 },
          insights: { items: [], total: 0 },
          actionItems: { items: [], total: 0 },
        },
      });
    }

    const limitParam = req.nextUrl.searchParams.get('limit');
    const limit = limitParam === null ? undefined : Number(limitParam);
    if (limit !== undefined && !Number.isFinite(limit)) {
      return NextResponse.json({ error: 'Invalid limit param' }, { status: 400 });
    }

    const db = createDb();
    const { profileService } = createContainer(db, workspaceId);
    const data = await profileService.getMyItems(userId, { limit });

    return NextResponse.json({ data });
  } catch (err) {
    console.error('[GET /api/profile/items]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
