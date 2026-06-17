import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services';
import { UserNotRegisteredError } from '@/lib/services/authService';

/**
 * Pre-flight check for the "Sign in with Google" button.
 *
 * The browser hands us the Google-issued ID token (the GIS credential). We
 * verify it against Google and confirm a local account exists for the verified
 * email. This endpoint never establishes a session — that still happens through
 * the `google-sso` NextAuth provider. Its sole job is to give the login page a
 * precise, user-facing reason when sign-in can't proceed (the NextAuth provider
 * collapses every failure into an opaque `CredentialsSignin` code, so the exact
 * "not registered" message can only be surfaced from here).
 *
 * Public route: a caller can only mint a valid Google token for their own
 * identity, so this leaks no account-enumeration signal about other emails.
 */
export async function POST(req: NextRequest) {
  try {
    const { token } = await req.json();
    if (typeof token !== 'string' || !token) {
      return NextResponse.json({ error: 'Missing Google token' }, { status: 400 });
    }

    const db = createDb();
    const { authService } = createContainer(db);

    try {
      const user = await authService.signInWithGoogleToken(token);
      return NextResponse.json({ data: { email: user.email } });
    } catch (err) {
      if (err instanceof UserNotRegisteredError) {
        // 403: the Google identity is valid, but it maps to no local account.
        return NextResponse.json({ error: err.message }, { status: 403 });
      }
      // Any other failure here is an untrusted/invalid token (bad signature,
      // expired, unverified email, wrong audience).
      console.error('[auth] google-signin token rejected:', err);
      return NextResponse.json({ error: 'Google sign-in failed' }, { status: 401 });
    }
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
