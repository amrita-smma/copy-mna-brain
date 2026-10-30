/**
 * The httpOnly cookie that carries the sealed PendingAuthorization from the
 * connect route to the callback. Scoped to the integration's routes and
 * short-lived. `lax` so the top-level redirect back from Google still sends it.
 */
export const STATE_COOKIE_NAME = 'gmail_oauth_state';
export const STATE_COOKIE_PATH = '/api/integrations/gmail';
export const STATE_COOKIE_MAX_AGE_SECONDS = 600;

export function stateCookieOptions(secure: boolean) {
  return {
    httpOnly: true,
    secure,
    sameSite: 'lax' as const,
    path: STATE_COOKIE_PATH,
    maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
  };
}
