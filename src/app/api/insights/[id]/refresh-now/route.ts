import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { isUuid } from '@/lib/uuid';
import { routineErrorResponse } from '@/app/api/routines/errorResponse';

/**
 * Refresh an insight now — "Refresh this insight now" on the CoPilot's
 * refresh card (MB-552). Through the insight's refresh routine when it has
 * one (the force-run path, so a paused or deprecated binding answers 409), or
 * as a one-off refresh run that publishes through MB-558 when it has none.
 * 201 with the new run; 200 with `created: false` when a refresh of the
 * insight is already queued or running.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let insightId = '';
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    insightId = id;
    if (!isUuid(id)) {
      return NextResponse.json({ error: 'Insight not found' }, { status: 404 });
    }
    const workspaceId = await getActiveWorkspaceIdOrThrow();
    const db = createDb();
    const { routineService } = createContainer(db, workspaceId);

    const data = await routineService.runInsightRefreshNow(id, session.user.id);
    return NextResponse.json({ data }, { status: data.created ? 201 : 200 });
  } catch (error: unknown) {
    return routineErrorResponse(error, `[POST /api/insights/${insightId}/refresh-now]`);
  }
}
