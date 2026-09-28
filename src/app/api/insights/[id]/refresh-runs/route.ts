import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { insightErrorResponse } from '@/app/api/insights/errorResponse';

/**
 * The insight's refresh runs that failed or were cancelled, for its version
 * history. Successful runs are already there as versions. A separate endpoint
 * rather than a field on GET /api/insights/[id], which the insight page loads
 * on every view; only the history dialog needs this.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let insightId = '';
  try {
    const { id } = await params;
    insightId = id;
    const workspaceId = await getActiveWorkspaceIdOrThrow();
    const db = createDb();
    const { aiWorkforceService } = createContainer(db, workspaceId);

    const data = await aiWorkforceService.listFailedRefreshRuns(id);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return insightErrorResponse(
      error,
      `[GET /api/insights/${insightId}/refresh-runs]`,
    );
  }
}
