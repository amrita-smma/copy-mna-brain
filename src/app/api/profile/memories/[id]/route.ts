import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { getSession } from '@/lib/server/session';

/**
 * Forget one memory from Profile → Memory.
 *
 * The delete is scoped to the session user inside the service, so an id
 * belonging to another member matches nothing and comes back 404 — never a
 * signal that the memory exists.
 *
 * Not gated on `copilotMemoryEnabled`, for the reason on the collection-level
 * DELETE: switching the feature off must not strand data a user may want gone.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const workspaceId = await getActiveWorkspaceId();
    if (!workspaceId) {
      return NextResponse.json({ error: 'No active workspace' }, { status: 400 });
    }

    const { id } = await params;
    const db = createDb();
    const { userMemoryService } = createContainer(db, workspaceId);
    const forgotten = await userMemoryService(userId).forget(id);

    if (!forgotten) {
      return NextResponse.json({ error: 'Memory not found' }, { status: 404 });
    }
    return NextResponse.json({ data: { id } });
  } catch (err) {
    console.error('[DELETE /api/profile/memories/:id]', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
