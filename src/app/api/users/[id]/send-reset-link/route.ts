import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { UserNotFoundError } from '@/lib/services/userService';
import { MNA_WORKSPACE_ID } from '@/lib/constants';

/**
 * Admin-triggered password-reset link, from the admin portal's User
 * Management section. Delegates to `AuthService.forgetPassword` — the same
 * mechanism the self-service "Forgot password?" flow uses. Superadmin-only.
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
    await userService.sendResetLink(id, req.nextUrl.origin);
    return NextResponse.json({ data: { success: true } });
  } catch (error: unknown) {
    if (error instanceof UserNotFoundError) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }
    const message = error instanceof Error ? error.message : 'Failed to send reset link';
    const status = message === 'This user has no email on file' ? 400 : 500;
    if (status === 500) console.error(error);
    return NextResponse.json({ error: message }, { status });
  }
}
