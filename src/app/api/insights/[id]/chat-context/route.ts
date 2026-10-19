import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { isUuid } from '@/lib/uuid';
import { insightErrorResponse } from '@/app/api/insights/errorResponse';

/**
 * The outline of an insight's current version that a CoPilot turn made while
 * the insight is open carries as context (MB-550) — the same value the chat
 * route sends, for the CoPilot's "context in use" panel.
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

    const data = await insightService.getChatContext(workspaceId, id);
    if (!data) {
      return NextResponse.json({ error: 'Insight not found' }, { status: 404 });
    }
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return insightErrorResponse(error, `[GET /api/insights/${insightId}/chat-context]`);
  }
}
