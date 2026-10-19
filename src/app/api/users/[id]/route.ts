import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import type { DbClient } from '@/lib/repositories';
import { createContainer } from '@/lib/services/container';
import {
  CannotDeactivateSelfError,
  UserNotFoundError,
} from '@/lib/services/userService';
import { MNA_WORKSPACE_ID } from '@/lib/constants';

/** Shared gate for every handler in this file: a logged-in superadmin. */
async function requireSuperadmin(db: DbClient) {
  const session = await auth();
  if (!session?.user?.id) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) } as const;
  }
  const container = createContainer(db, MNA_WORKSPACE_ID);
  if (!(await container.workspaceService.isSuperadmin(session.user.id))) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) } as const;
  }
  return { session, container } as const;
}

/**
 * Change a user's name and/or email from the admin portal's User Management
 * section. Superadmin-only.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const db = createDb();
    const gate = await requireSuperadmin(db);
    if ('error' in gate) return gate.error;

    const { id } = await params;
    const { name, email } = await req.json();
    if (name === undefined && email === undefined) {
      return NextResponse.json({ error: 'name or email is required' }, { status: 400 });
    }

    const data = await gate.container.userService.updateProfile(id, { name, email });
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof UserNotFoundError) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : 'Failed to update user';
    const status = message === 'Email already registered' ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

/**
 * Deactivate a user (soft — the row and its history are kept). Superadmin-
 * only, and a superadmin cannot deactivate their own account.
 */
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const db = createDb();
    const gate = await requireSuperadmin(db);
    if ('error' in gate) return gate.error;

    const { id } = await params;
    const data = await gate.container.userService.deactivateUser(gate.session.user.id, id);
    return NextResponse.json({ data });
  } catch (error: unknown) {
    if (error instanceof UserNotFoundError) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    if (error instanceof CannotDeactivateSelfError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error(error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
