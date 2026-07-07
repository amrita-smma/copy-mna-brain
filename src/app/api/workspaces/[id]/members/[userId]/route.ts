import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { MNA_WORKSPACE_ID } from '@/lib/constants';
import { RoleNotFoundError } from '@/lib/services/workspaceService';

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
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
    const { id, userId } = await params;
    const { roleName, isEmailSynced } = await req.json();
    const hasRoleName = typeof roleName === 'string' && roleName.length > 0;
    const hasEmailSynced = typeof isEmailSynced === 'boolean';
    // Exactly one field per request — not "at least one". Each maps to its
    // own single-column UPDATE...RETURNING, so allowing both in one request
    // would run two separate writes and return only the second one's row,
    // silently dropping the first write's result from the response.
    if (hasRoleName === hasEmailSynced) {
      return NextResponse.json(
        { error: 'Provide exactly one of roleName or isEmailSynced' },
        { status: 400 },
      );
    }
    const data = hasRoleName
      ? await workspaceService.setMemberRole(userId, id, roleName)
      : await workspaceService.setMemberEmailSync(userId, id, isEmailSynced);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof RoleNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> },
) {
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
    const { id, userId } = await params;
    await workspaceService.removeMember(userId, id);
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
