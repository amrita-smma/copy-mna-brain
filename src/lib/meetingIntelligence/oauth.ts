import { createHash, randomBytes } from 'node:crypto';
import {
  MEETING_INTELLIGENCE_CLIENT_NAME,
  MEETING_INTELLIGENCE_SCOPE,
  type MeetingIntelligenceEndpoints,
} from './config';

/**
 * The OAuth 2.1 half of the Meeting Intelligence integration: dynamic client
 * registration, the PKCE (S256) authorization-code flow, refresh and revoke.
 * We are a public client (`token_endpoint_auth_method: none`) — there is no
 * client secret anywhere. Plain HTTP helpers; persistence and the
 * refresh-rotation rules live in `MeetingIntelligenceService`.
 */

/**
 * Every OAuth call gives up after this long — well inside the 30 s refresh
 * lease, so a hung refresh can't outlive the lease and let a second request
 * rotate the same refresh token.
 */
const OAUTH_TIMEOUT_MS = 15_000;

/** An OAuth error response, carrying the server's `error` code (e.g. `invalid_grant`). */
export class MeetingIntelligenceOAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'MeetingIntelligenceOAuthError';
  }
}

export interface PkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

/** A fresh PKCE verifier (43 chars, base64url of 32 random bytes) and its S256 challenge. */
export function generatePkce(): PkcePair {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

/** An unguessable `state` value for CSRF protection on the callback. */
export function generateState(): string {
  return randomBytes(24).toString('base64url');
}

export interface MeetingIntelligenceTokens {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry of the access token. */
  expiresAt: Date;
  scope: string | null;
}

async function readOAuthError(res: Response, fallback: string): Promise<MeetingIntelligenceOAuthError> {
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
  return new MeetingIntelligenceOAuthError(code, message, res.status);
}

/**
 * Register this app as a public client for one redirect URI (RFC 7591). The
 * redirect URI's domain must be whitelisted on the server, else
 * `invalid_redirect_uri`.
 */
export async function registerClient(
  endpoints: MeetingIntelligenceEndpoints,
  redirectUri: string,
): Promise<string> {
  const res = await fetch(endpoints.register, {
    method: 'POST',
    signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: MEETING_INTELLIGENCE_CLIENT_NAME,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: MEETING_INTELLIGENCE_SCOPE,
    }),
  });
  if (!res.ok) throw await readOAuthError(res, 'Client registration failed');
  const body = (await res.json()) as { client_id?: unknown };
  if (typeof body.client_id !== 'string' || !body.client_id) {
    throw new MeetingIntelligenceOAuthError('invalid_client_metadata', 'Registration returned no client_id', res.status);
  }
  return body.client_id;
}

/** The URL to send the member's browser to for sign-in and consent. */
export function buildAuthorizeUrl(
  endpoints: MeetingIntelligenceEndpoints,
  params: { clientId: string; redirectUri: string; codeChallenge: string; state: string },
): string {
  const url = new URL(endpoints.authorize);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', params.state);
  url.searchParams.set('scope', MEETING_INTELLIGENCE_SCOPE);
  url.searchParams.set('resource', endpoints.mcp);
  return url.toString();
}

async function postToken(
  endpoints: MeetingIntelligenceEndpoints,
  form: Record<string, string>,
  fallback: string,
): Promise<MeetingIntelligenceTokens> {
  const res = await fetch(endpoints.token, {
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
  if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') {
    throw new MeetingIntelligenceOAuthError('invalid_response', `${fallback}: token response is missing tokens`, res.status);
  }
  const expiresIn = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: new Date(Date.now() + expiresIn * 1000),
    scope: typeof body.scope === 'string' ? body.scope : null,
  };
}

/** Exchange an authorization code (valid for 60 s) for tokens. */
export function exchangeCode(
  endpoints: MeetingIntelligenceEndpoints,
  params: { clientId: string; code: string; codeVerifier: string; redirectUri: string },
): Promise<MeetingIntelligenceTokens> {
  return postToken(
    endpoints,
    {
      grant_type: 'authorization_code',
      client_id: params.clientId,
      code: params.code,
      code_verifier: params.codeVerifier,
      redirect_uri: params.redirectUri,
    },
    'Token exchange failed',
  );
}

/**
 * Trade the latest refresh token for a new pair. The server rotates: the
 * returned refresh token replaces the old one, and presenting the old one
 * again disconnects the member.
 */
export function refreshTokens(
  endpoints: MeetingIntelligenceEndpoints,
  params: { clientId: string; refreshToken: string },
): Promise<MeetingIntelligenceTokens> {
  return postToken(
    endpoints,
    {
      grant_type: 'refresh_token',
      client_id: params.clientId,
      refresh_token: params.refreshToken,
    },
    'Token refresh failed',
  );
}

/** Revoke a token (RFC 7009). Best effort: never throws. */
export async function revokeToken(
  endpoints: MeetingIntelligenceEndpoints,
  params: { clientId: string; token: string },
): Promise<void> {
  try {
    await fetch(endpoints.revoke, {
      method: 'POST',
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: params.token, client_id: params.clientId }).toString(),
    });
  } catch {
    // The member is disconnected locally either way; a failed revoke just
    // leaves the grant to expire (or be removed from their dashboard).
  }
}
