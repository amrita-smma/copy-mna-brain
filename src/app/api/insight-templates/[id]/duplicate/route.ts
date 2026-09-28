import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { insightTemplateErrorResponse } from '@/app/api/insight-templates/errorResponse';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const workspaceId = await getActiveWorkspaceIdOrThrow();
    const db = createDb();
    const { insightTemplateService } = createContainer(db, workspaceId);

    const data = await insightTemplateService.duplicate(id, session.user.id);
    return NextResponse.json({ data }, { status: 201 });
  } catch (error: unknown) {
    return insightTemplateErrorResponse(
      error,
      '[POST /api/insight-templates/[id]/duplicate]',
    );
  }
}
