import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceId, getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { getSession } from '@/lib/server/session';
import { taskErrorResponse } from './errorResponse';

/**
 * The signed-in user's personal to-do list in the active workspace.
 *
 * Always scoped to the session user — there is no `userId` param, so one
 * member can never read or add to another's list.
 */
export async function GET() {
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const workspaceId = await getActiveWorkspaceId();
    if (!workspaceId) return NextResponse.json({ data: [] });

    const db = createDb();
    const { userTaskService } = createContainer(db, workspaceId);
    return NextResponse.json({ data: await userTaskService.list(userId) });
  } catch (err) {
    console.error('[GET /api/tasks]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/** Body: `{ title: string, remindAt?: string | null }` (ISO timestamp). */
export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Writes refuse the fail-closed sentinel rather than stamping it on a row.
    const workspaceId = await getActiveWorkspaceIdOrThrow();

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const db = createDb();
    const { userTaskService } = createContainer(db, workspaceId);
    const task = await userTaskService.create(userId, {
      title: body.title,
      remindAt: body.remindAt,
    });
    return NextResponse.json({ data: task }, { status: 201 });
  } catch (err) {
    return taskErrorResponse(err, '[POST /api/tasks]');
  }
}
