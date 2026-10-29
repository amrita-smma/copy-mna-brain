/**
 * The httpOnly cookie that carries the sealed PendingAuthorization from the
 * connect route to the callback. Scoped to the integration's routes and
 * short-lived — the server gives the member 10 minutes to sign in. `lax` so
 * the top-level redirect back from the authorization server still sends it.
 */
export const STATE_COOKIE_NAME = 'mi_oauth_state';
export const STATE_COOKIE_PATH = '/api/integrations/meeting-intelligence';
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
