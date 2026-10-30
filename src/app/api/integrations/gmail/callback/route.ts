import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { getSession } from '@/lib/server/session';
import { DEFAULT_RETURN_PATH, resultUrl, STATE_COOKIE_NAME, stateCookieOptions } from '@/lib/gmail';
import { GmailAuthorizationError } from '@/lib/services/gmailService';

/**
 * The OAuth redirect URI: Google sends the member's browser here with
 * `?code=&state=` after they approve (or `?error=access_denied` if they
 * declined). Opens the sealed state cookie set by the connect route, verifies
 * it belongs to this member and matches `state`, exchanges the code, and
 * redirects back to where they started with `?gmail=connected|error`.
 */
export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const params = req.nextUrl.searchParams;
  let returnTo = DEFAULT_RETURN_PATH;

  const finish = (url: URL) => {
    const res = NextResponse.redirect(url);
    res.cookies.set(STATE_COOKIE_NAME, '', { ...stateCookieOptions(origin.startsWith('https:')), maxAge: 0 });
    return res;
  };

  try {
    const session = await getSession();
    const userId = session?.user?.id;
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { gmailService } = createContainer(createDb(), await getActiveWorkspaceId());
    const pending = gmailService.openPendingAuthorization(req.cookies.get(STATE_COOKIE_NAME)?.value);
    if (!pending) {
      return finish(resultUrl(origin, returnTo, 'error', 'expired'));
    }
    returnTo = pending.returnTo;

    const error = params.get('error');
    if (error) {
      return finish(resultUrl(origin, returnTo, 'error', error));
    }
    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) {
      return finish(resultUrl(origin, returnTo, 'error', 'invalid_request'));
    }

    await gmailService.completeAuthorization({ userId, pending, state, code });
    return finish(resultUrl(origin, returnTo, 'connected'));
  } catch (err) {
    if (!(err instanceof GmailAuthorizationError)) console.error(err);
    const reason = err instanceof GmailAuthorizationError ? err.reason : 'authorization_failed';
    return finish(resultUrl(origin, returnTo, 'error', reason));
  }
}
