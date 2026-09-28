import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { routineErrorResponse } from '@/app/api/routines/errorResponse';

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
    const { routineService } = createContainer(db, workspaceId);

    const data = await routineService.getActiveForInsight(id);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return routineErrorResponse(
      error,
      `[GET /api/insights/${insightId}/refresh-routine]`,
    );
  }
}
