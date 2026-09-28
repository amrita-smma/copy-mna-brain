import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { isUuid } from '@/lib/uuid';
import { insightErrorResponse } from '@/app/api/insights/errorResponse';

/**
 * The insight's current version number, publish time and trigger — no HTML
 * (MB-554). An open CoPilot edit card polls it to notice that a scheduled
 * refresh published over the version it is diffing against.
 */
export async function GET(
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
    const { insightService } = createContainer(db, workspaceId);

    const data = await insightService.getHead(workspaceId, id);
    if (!data) {
      return NextResponse.json({ error: 'Insight not found' }, { status: 404 });
    }
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return insightErrorResponse(error, `[GET /api/insights/${insightId}/head]`);
  }
}
