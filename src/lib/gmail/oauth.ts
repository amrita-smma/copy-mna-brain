import {
  GMAIL_SCOPES,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_REVOKE_URL,
  GOOGLE_TOKEN_URL,
  type GmailCredentials,
} from './config';

// PKCE and `state` are provider-agnostic; reuse the helpers rather than copy them.
export { generatePkce, generateState } from '@/lib/meetingIntelligence/oauth';

/**
 * The Google OAuth 2.0 half of the Gmail integration: the authorization-code
 * flow with PKCE (S256) and offline access, refresh and revoke. Unlike the
 * Meeting Intelligence server, Google makes us a *confidential* client — the
 * client secret goes on every token call. Plain HTTP helpers; persistence and
 * the refresh rules live in `GmailService`.
 */

/** Every OAuth call gives up after this long, so a hung Google never holds a request open. */
const OAUTH_TIMEOUT_MS = 15_000;

/** An OAuth error response, carrying Google's `error` code (e.g. `invalid_grant`). */
export class GmailOAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GmailOAuthError';
  }
}

export interface GmailTokens {
  accessToken: string;
  /** Present on the first consent; Google omits it on a refresh unless it rotates. */
  refreshToken: string | null;
  /** Absolute expiry of the access token. */
  expiresAt: Date;
  /** The scopes Google actually granted, space separated. */
  scope: string | null;
}

/**
 * The URL to send the member's browser to for sign-in and consent.
 * `access_type=offline` + `prompt=consent` make Google return a refresh token
 * on every connect, not only the first — a reconnect after a revoke would
 * otherwise come back without one.
 */
export function buildAuthorizeUrl(
  credentials: GmailCredentials,
  params: { redirectUri: string; codeChallenge: string; state: string },
): string {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', credentials.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('scope', GMAIL_SCOPES.join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  return url.toString();
}

async function readOAuthError(res: Response, fallback: string): Promise<GmailOAuthError> {
  let code = 'server_error';
  let message = `${fallback} (HTTP ${res.status})`;
  try {
    const body = (await res.json()) as { error?: unknown; error_description?: unknown };
    if (typeof body.error === 'string') code = body.error;
    if (typeof body.error_description === 'string') message = `${fallback}: ${body.error_description}`;
    else if (typeof body.error === 'string') message = `${fallback}: ${body.error}`;
  } catch {
    // Non-JSON error body — keep the generic message.
  }
  return new GmailOAuthError(code, message, res.status);
}

async function postToken(form: Record<string, string>, fallback: string): Promise<GmailTokens> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) throw await readOAuthError(res, fallback);
  const body = (await res.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    scope?: unknown;
  };
  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new GmailOAuthError('invalid_response', `${fallback}: token response has no access token`, res.status);
  }
  const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scope: typeof body.scope === 'string' ? body.scope : null,
  };
}

/** Exchange an authorization code for tokens. */
export function exchangeCode(
  credentials: GmailCredentials,
  params: { code: string; codeVerifier: string; redirectUri: string },
): Promise<GmailTokens> {
  return postToken(
    {
      grant_type: 'authorization_code',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
    },
    'Token exchange failed',
  );
}

/** Trade the refresh token for a new access token. */
export function refreshAccessToken(
  credentials: GmailCredentials,
  params: { refreshToken: string },
): Promise<GmailTokens> {
  return postToken(
    {
      grant_type: 'refresh_token',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: params.refreshToken,
    },
    'Token refresh failed',
  );
}

/** Revoke a token (revoking the refresh token ends the whole grant). Best effort: never throws. */
export async function revokeToken(params: { token: string }): Promise<void> {
  try {
    await fetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: params.token }).toString(),
    });
  } catch {
    // The member is disconnected locally either way; a failed revoke leaves
    // the grant to be removed from their Google account page.
  }
}
