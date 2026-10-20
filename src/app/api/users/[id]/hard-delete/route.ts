import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import {
  CannotDeleteSelfError,
  DeleteConfirmationMismatchError,
  UserHasRetainedHistoryError,
  UserNotDeactivatedError,
  UserNotFoundError,
} from '@/lib/services/userService';
import { MNA_WORKSPACE_ID } from '@/lib/constants';

/**
 * Permanently delete a deactivated user. Superadmin-only. The body must carry
 * `confirmName` matching the user's name exactly — the admin portal makes the
 * superadmin type it, and the check is repeated here so the API can't skip it.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const db = createDb();
    const { workspaceService, userService } = createContainer(db, MNA_WORKSPACE_ID);
    if (!(await workspaceService.isSuperadmin(session.user.id))) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const confirmName = body?.confirmName;
    if (typeof confirmName !== 'string') {
      return NextResponse.json({ error: 'confirmName is required' }, { status: 400 });
    }
    const data = await userService.hardDeleteUser(session.user.id, id, confirmName);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof UserNotFoundError) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    if (error instanceof CannotDeleteSelfError || error instanceof DeleteConfirmationMismatchError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof UserNotDeactivatedError || error instanceof UserHasRetainedHistoryError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
