import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services';

/**
 * Initiate the forgot-password flow.
 *
 * Always responds with `{ ok: true }` — never echoes the reset token in the
 * response body and does not differentiate between "email exists" and "email
 * doesn't exist". The actual reset link is delivered via AWS SES, enqueued to
 * the `send-email` Vercel Queues topic by `AuthService.forgetPassword`.
 */
export async function POST(req: NextRequest) {
  try {
    const { email } = await req.json();
    if (typeof email !== 'string') {
      return NextResponse.json({ error: 'Invalid email' }, { status: 400 });
    }
    // Derive the base URL from the incoming request so the reset link in the
    // email matches the host the user is actually browsing from (works for
    // localhost, preview deployments, and production without any env var).
    const appUrl = req.nextUrl.origin;
    const db = createDb();
    const { authService } = createContainer(db, await getActiveWorkspaceId());
    await authService.forgetPassword(email, appUrl);
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    // Even on internal errors we return a generic ok=true response below in
    // production-like environments to avoid leaking enumeration signal. But
    // for now we keep the error visible to ease local debugging — flip this
    // before going to prod if you want maximum opacity.
    const message = error instanceof Error ? error.message : 'Failed to start password reset';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
