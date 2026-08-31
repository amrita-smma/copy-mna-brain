import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';
import { MNA_WORKSPACE_ID } from '@/lib/constants';

/**
 * Selectable users. Defaults to members of the active workspace — this backs
 * the "Entered by" / Deal Sponsor / Deal Captain pickers, whose values are
 * uuid FKs that only make sense inside the current workspace.
 *
 * `?scope=all` returns the global user directory instead, so the admin portal
 * can offer people who are *not* yet members when adding them to a workspace.
 * That path is superadmin-only.
 */
export async function GET(req: NextRequest) {
  try {
    const db = createDb();

    if (req.nextUrl.searchParams.get('scope') === 'all') {
      const session = await auth();
      if (!session?.user?.id) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      const { workspaceService, userService } = createContainer(db, MNA_WORKSPACE_ID);
      if (!(await workspaceService.isSuperadmin(session.user.id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      return NextResponse.json({ data: await userService.listAll() });
    }

    const { userService } = createContainer(db, await getActiveWorkspaceId());
    const data = await userService.list();
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to list users';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
