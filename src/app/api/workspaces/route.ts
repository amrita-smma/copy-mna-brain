import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { MNA_WORKSPACE_ID } from '@/lib/constants';

export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const db = createDb();
    const { workspaceService } = createContainer(db, MNA_WORKSPACE_ID);

    // `?all=true` lists every raw workspace row (admin-portal CRUD use) —
    // superadmin only, since a superadmin may have zero memberships of their
    // own. Default (no param) lists workspaces the caller can actually enter:
    // real memberships, plus every workspace for a superadmin (implicit
    // access, no user_workspaces row required) — this feeds the /workspace
    // picker and the nav switcher.
    if (req.nextUrl.searchParams.get('all') === 'true') {
      if (!(await workspaceService.isSuperadmin(session.user.id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      const data = await workspaceService.listWorkspaces();
      return NextResponse.json({ data });
    }

    const data = await workspaceService.getAccessibleWorkspacesForUser(session.user.id);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const db = createDb();
    const { workspaceService } = createContainer(db, MNA_WORKSPACE_ID);
    if (!(await workspaceService.isSuperadmin(session.user.id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const { name, slug } = await req.json();
    if (!name || !slug) {
      return NextResponse.json({ error: 'name and slug are required' }, { status: 400 });
    }
    const data = await workspaceService.createWorkspace({ name, slug });
    return NextResponse.json({ data }, { status: 201 });
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
