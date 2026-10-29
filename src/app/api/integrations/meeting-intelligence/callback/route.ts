import { NextRequest, NextResponse } from 'next/server';
import { createDb } from '@/lib/server/db';
import { createContainer } from '@/lib/services/container';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { getSession } from '@/lib/server/session';
import {
  DEFAULT_RETURN_PATH,
  resultUrl,
  STATE_COOKIE_NAME,
  stateCookieOptions,
} from '@/lib/meetingIntelligence';
import { MeetingIntelligenceAuthorizationError } from '@/lib/services/meetingIntelligenceService';

/**
 * The OAuth redirect URI: Meeting Intelligence sends the member's browser here
 * with `?code=&state=` after they approve (or `?error=` if they declined).
 * Opens the sealed state cookie set by the connect route, verifies it belongs
 * to this member and matches `state`, exchanges the code, and redirects back
 * to where they started with `?meetingIntelligence=connected|error`.
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

    const { meetingIntelligenceService } = createContainer(createDb(), await getActiveWorkspaceId());
    const pending = meetingIntelligenceService.openPendingAuthorization(
      req.cookies.get(STATE_COOKIE_NAME)?.value,
    );
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

    await meetingIntelligenceService.completeAuthorization({ userId, pending, state, code });
    return finish(resultUrl(origin, returnTo, 'connected'));
  } catch (err) {
    if (!(err instanceof MeetingIntelligenceAuthorizationError)) console.error(err);
    return finish(resultUrl(origin, returnTo, 'error', 'authorization_failed'));
  }
}
