import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { getActiveWorkspaceIdOrThrow } from '@/lib/workspace';
import { getSession } from '@/lib/server/session';
import { taskErrorResponse } from '../errorResponse';

type Params = { params: Promise<{ id: string }> };

/**
 * Edit, complete/reopen, or delete one of the session user's tasks. A task id
 * belonging to someone else matches nothing and comes back 404.
 *
 * PATCH body: any of `{ title, remindAt, completed }`.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
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

    const { id } = await params;
    const db = createDb();
    const { userTaskService } = createContainer(db, workspaceId);
    const task = await userTaskService.update(userId, id, {
      title: body.title,
      remindAt: body.remindAt,
      completed: body.completed,
    });
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    return NextResponse.json({ data: task });
  } catch (err) {
    return taskErrorResponse(err, '[PATCH /api/tasks/:id]');
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Writes refuse the fail-closed sentinel rather than stamping it on a row.
    const workspaceId = await getActiveWorkspaceIdOrThrow();

    const { id } = await params;
    const db = createDb();
    const { userTaskService } = createContainer(db, workspaceId);
    const deleted = await userTaskService.delete(userId, id);
    if (!deleted) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    return NextResponse.json({ data: { id } });
  } catch (err) {
    return taskErrorResponse(err, '[DELETE /api/tasks/:id]');
  }
}
