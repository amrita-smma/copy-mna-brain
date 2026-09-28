import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId, getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { auth } from '@/auth';
import { insightErrorResponse } from '@/app/api/insights/errorResponse';
import { parseInsightListQuery } from '@/lib/insights/listQuery';

/**
 * One page of the workspace's insights: `?q=&agent=&mine=&archived=&limit=&offset=`
 * → `{ data: { items, total } }`. See parseInsightListQuery for the params.
 */
export async function GET(req: NextRequest) {
  try {
    const parsed = parseInsightListQuery(req.nextUrl.searchParams);
    if ('error' in parsed) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }
    const workspaceId = await getActiveWorkspaceId();
    if (!workspaceId) {
      return NextResponse.json({ data: { items: [], total: 0 } });
    }
    const db = createDb();
    const { insightService } = createContainer(db, workspaceId);
    // Only `mine` needs the user; the service matches nothing without one.
    const userId = parsed.query.mine ? ((await auth())?.user?.id ?? null) : null;
    const data = await insightService.list(workspaceId, { ...parsed.query, userId });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    return insightErrorResponse(error, '[GET /api/insights]');
  }
}

export async function POST(req: NextRequest) {
  try {
    const workspaceId = await getActiveWorkspaceIdOrThrow();
    const db = createDb();
    const { insightService, copilotChatsService } = createContainer(db, workspaceId);

    const body = await req.json();
    const {
      name,
      description,
      html,
      kind,
      chat_id: chatId,
      template_id: templateId,
    } = body ?? {};

    if (!name || typeof name !== 'string') {
      return NextResponse.json(
        { error: 'Missing required field: name' },
        { status: 400 },
      );
    }

    if (html === undefined || html === null || typeof html !== 'string') {
      return NextResponse.json(
        { error: 'Missing required field: html' },
        { status: 400 },
      );
    }

    if (kind !== undefined && kind !== 'document' && kind !== 'report') {
      return NextResponse.json(
        { error: 'Invalid field: kind must be "document" or "report"' },
        { status: 400 },
      );
    }

    const session = await auth();
    const userId = session?.user?.id ?? null;

    // Created from an approved CoPilot card: stamp v1 with the agent the chat
    // thread runs on (MB-549), read from the chat row — never from the body.
    const agentStamp =
      typeof chatId === 'string' && userId
        ? await copilotChatsService.agentStampFor(chatId, userId)
        : null;

    const data = await insightService.createFromDocument({
      name,
      description,
      html,
      kind,
      workspaceId,
      userId,
      agentStamp,
      // Never a 400: the service keeps it only when it names a live template
      // in this workspace, and stores null otherwise.
      templateId: typeof templateId === 'string' ? templateId : null,
    });
    return NextResponse.json({ data }, { status: 201 });
  } catch (error: unknown) {
    return insightErrorResponse(error, '[POST /api/insights]');
  }
}
