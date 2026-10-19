import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { NotSuperadminError, WorkspaceNotFoundError } from '@/lib/services/workspaceService';
import { MNA_WORKSPACE_ID } from '@/lib/constants';

/**
 * Reinstate a soft-deleted workspace. Superadmin-only (enforced here and
 * again in the service). Reinstating is a no-op on a workspace that isn't
 * archived, so a double-click can't fail.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const db = createDb();
    const { workspaceService } = createContainer(db, MNA_WORKSPACE_ID);
    const { id } = await params;
    const data = await workspaceService.restoreWorkspace(session.user.id, id);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof NotSuperadminError) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (error instanceof WorkspaceNotFoundError) {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
