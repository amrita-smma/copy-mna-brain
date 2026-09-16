import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

/**
 * Admin-only account creation, triggered from the admin portal. Gated by the
 * shared `X-Api-Secret` (`ADMIN_SECRET`) in `proxy.ts`, not a NextAuth
 * session. No password is accepted here — `AuthService.signUp` creates the
 * account with a random, never-communicated password and emails the new user
 * a one-time link to set their own password (see `/reset-password`).
 */
export async function POST(req: NextRequest) {
  try {
    const { email, name } = await req.json();
    const db = createDb();
    const { authService } = createContainer(db, await getActiveWorkspaceId());
    const user = await authService.signUp(email, name, req.nextUrl.origin);
    return NextResponse.json({ data: user }, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Signup failed';
    const status = message === 'Email already registered' ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
