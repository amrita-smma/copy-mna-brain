import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { getSession } from '@/lib/server/session';
import { meetingIntelligenceEnabled } from '@/lib/flags';
import {
  MEETING_INTELLIGENCE_CALLBACK_PATH,
  MeetingIntelligenceOAuthError,
  resultUrl,
  safeReturnPath,
  STATE_COOKIE_NAME,
  stateCookieOptions,
} from '@/lib/meetingIntelligence';

/**
 * Start connecting Meeting Intelligence: a browser navigation from the
 * Profile card (`?returnTo=<current path>`). Registers this app as an OAuth
 * client for this origin's callback on first use, seals the PKCE verifier and
 * state into an httpOnly cookie, and redirects to the server's sign-in and
 * consent page. Failures redirect back to `returnTo` with
 * `?meetingIntelligence=error` so the card can explain.
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
    if (!(await meetingIntelligenceEnabled())) {
      return NextResponse.redirect(resultUrl(origin, returnTo, 'error', 'not_enabled'));
    }

    const { meetingIntelligenceService } = createContainer(createDb(), await getActiveWorkspaceId());
    const { authorizeUrl, sealedState } = await meetingIntelligenceService.beginAuthorization({
      userId,
      redirectUri: `${origin}${MEETING_INTELLIGENCE_CALLBACK_PATH}`,
      returnTo,
    });

    const res = NextResponse.redirect(authorizeUrl);
    res.cookies.set(STATE_COOKIE_NAME, sealedState, stateCookieOptions(origin.startsWith('https:')));
    return res;
  } catch (err) {
    console.error(err);
    const reason = err instanceof MeetingIntelligenceOAuthError ? err.code : 'server_error';
    return NextResponse.redirect(resultUrl(origin, returnTo, 'error', reason));
  }
}
