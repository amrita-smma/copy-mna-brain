import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { getSession } from '@/lib/server/session';
import { gmailEnabled } from '@/lib/flags';
import { GMAIL_CALLBACK_PATH, resultUrl, safeReturnPath, STATE_COOKIE_NAME, stateCookieOptions } from '@/lib/gmail';
import { GmailNotConfiguredError } from '@/lib/services/gmailService';

/**
 * Start connecting Gmail: a browser navigation from the Connected apps row
 * (`?returnTo=<current path>`). Seals the PKCE verifier and state into an
 * httpOnly cookie and redirects to Google's sign-in and consent page. Failures
 * redirect back to `returnTo` with `?gmail=error` so the row can explain.
 *
 * The redirect URI (`<origin>/api/integrations/gmail/callback`) must be listed
 * on the Google OAuth client, or Google refuses with `redirect_uri_mismatch`.
 */
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const returnTo = safeReturnPath(req.nextUrl.searchParams.get('returnTo'));
  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!(await gmailEnabled())) {
      return NextResponse.redirect(resultUrl(origin, returnTo, 'error', 'not_enabled'));
    }

    const { gmailService } = createContainer(createDb(), await getActiveWorkspaceId());
    const { authorizeUrl, sealedState } = gmailService.beginAuthorization({
      userId,
      redirectUri: `${origin}${GMAIL_CALLBACK_PATH}`,
      returnTo,
    });

    const res = NextResponse.redirect(authorizeUrl);
    res.cookies.set(STATE_COOKIE_NAME, sealedState, stateCookieOptions(origin.startsWith('https:')));
    return res;
  } catch (err) {
    console.error(err);
    const reason = err instanceof GmailNotConfiguredError ? 'not_configured' : 'server_error';
    return NextResponse.redirect(resultUrl(origin, returnTo, 'error', reason));
  }
}
