import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
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

    // `?scope=admin`: the full directory including deactivated users, for the
    // admin portal's User Management section. Superadmin-only, same gate as
    // `scope=all` above.
    if (req.nextUrl.searchParams.get('scope') === 'admin') {
      const session = await auth();
      if (!session?.user?.id) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      const { workspaceService, userService } = createContainer(db, MNA_WORKSPACE_ID);
      if (!(await workspaceService.isSuperadmin(session.user.id))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
      return NextResponse.json({ data: await userService.listAllForAdmin() });
    }

    const { userService } = createContainer(db, await getActiveWorkspaceId());
    const data = await userService.list();
    return NextResponse.json({ data });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to list users';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Superadmin-only account creation from the admin portal. Session-gated
 * (unlike `POST /api/auth/signup`, which is `X-Api-Secret` M2M). The
 * password is never chosen here — `AuthService.signUp` stores a random
 * unusable hash and emails a set-password link.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const db = createDb();
    const { workspaceService, authService } = createContainer(db, MNA_WORKSPACE_ID);
    if (!(await workspaceService.isSuperadmin(session.user.id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const { email, name } = await req.json();
    const user = await authService.signUp(email, name, req.nextUrl.origin);
    return NextResponse.json({ data: user }, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Signup failed';
    const status = message === 'Email already registered' ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
