import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { auth } from '@/auth';
import { insightErrorResponse } from '@/app/api/insights/errorResponse';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const workspaceId = await getActiveWorkspaceIdOrThrow();
    const db = createDb();
    const { insightService } = createContainer(db, workspaceId);

    const session = await auth();
    const userId = session?.user?.id ?? null;

    const data = await insightService.duplicate(workspaceId, id, userId);
    return NextResponse.json({ data }, { status: 201 });
  } catch (error: unknown) {
    return insightErrorResponse(error, '[POST /api/insights/[id]/duplicate]');
  }
}
