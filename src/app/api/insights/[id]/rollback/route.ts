import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { auth } from '@/auth';
import { insightErrorResponse } from '@/app/api/insights/errorResponse';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const workspaceId = await getActiveWorkspaceIdOrThrow();
    const db = createDb();
    const { insightService } = createContainer(db, workspaceId);

    const body = (await req.json()) ?? {};
    const toVersionNo = Number(body.toVersionNo ?? body.to_version_no);
    if (!Number.isInteger(toVersionNo) || toVersionNo < 1) {
      return NextResponse.json(
        { error: 'Missing or invalid toVersionNo' },
        { status: 400 },
      );
    }

    const session = await auth();
    const userId = session?.user?.id ?? null;

    const data = await insightService.rollback({
      workspaceId,
      insightId: id,
      toVersionNo,
      userId,
    });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return insightErrorResponse(error, '[POST /api/insights/[id]/rollback]');
  }
}
