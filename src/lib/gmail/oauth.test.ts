import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  exchangeCode,
  GmailOAuthError,
  refreshAccessToken,
  revokeToken,
} from './oauth';
import { GMAIL_COMPOSE_SCOPE, GMAIL_SCOPE } from './config';

const credentials = { clientId: 'cid', clientSecret: 'csecret' };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('buildAuthorizeUrl', () => {
  it('asks for read and compose-drafts Gmail access with PKCE, offline access and a forced consent screen', () => {
    const url = new URL(
      buildAuthorizeUrl(credentials, { redirectUri: 'https://app.test/cb', codeChallenge: 'chal', state: 'st' }),
    );
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'cid',
      redirect_uri: 'https://app.test/cb',
      scope: `${GMAIL_SCOPE} ${GMAIL_COMPOSE_SCOPE}`,
      state: 'st',
      code_challenge: 'chal',
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    });
  });

  it('requests drafts (compose) but never the modify or full-mailbox scopes', () => {
    expect(GMAIL_SCOPE).toBe('https://www.googleapis.com/auth/gmail.readonly');
    expect(GMAIL_COMPOSE_SCOPE).toBe('https://www.googleapis.com/auth/gmail.compose');
    const scope = new URL(
      buildAuthorizeUrl(credentials, { redirectUri: 'https://app.test/cb', codeChallenge: 'c', state: 's' }),
    ).searchParams.get('scope');
    expect(scope?.split(' ')).toEqual([GMAIL_SCOPE, GMAIL_COMPOSE_SCOPE]);
  });
});

describe('token calls', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-29T00:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const form = () => new URLSearchParams(fetchMock.mock.calls[0]![1].body as string);

  it('exchanges a code with the client secret and the PKCE verifier', async () => {
    fetchMock.mockResolvedValue(
      json({ access_token: 'at', refresh_token: 'rt', expires_in: 3599, scope: GMAIL_SCOPE }),
    );

    const tokens = await exchangeCode(credentials, { code: 'c', codeVerifier: 'v', redirectUri: 'https://app.test/cb' });

    expect(fetchMock.mock.calls[0]![0]).toBe('https://oauth2.googleapis.com/token');
    expect(Object.fromEntries(form())).toEqual({
      grant_type: 'authorization_code',
      client_id: 'cid',
      client_secret: 'csecret',
      code: 'c',
      code_verifier: 'v',
      redirect_uri: 'https://app.test/cb',
    });
    expect(tokens).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: new Date('2026-10-29T00:59:59Z'),
      scope: GMAIL_SCOPE,
    });
  });

  it('reports no refresh token when Google omits it (it does on a plain refresh)', async () => {
    fetchMock.mockResolvedValue(json({ access_token: 'at2', expires_in: 3600 }));
    const tokens = await refreshAccessToken(credentials, { refreshToken: 'rt' });
    expect(Object.fromEntries(form())).toEqual({
      grant_type: 'refresh_token',
      client_id: 'cid',
      client_secret: 'csecret',
      refresh_token: 'rt',
    });
    expect(tokens.refreshToken).toBeNull();
    expect(tokens.accessToken).toBe('at2');
  });

  it("surfaces Google's error code, so the service can tell a dead grant from a transient failure", async () => {
    fetchMock.mockResolvedValue(json({ error: 'invalid_grant', error_description: 'Token has been revoked.' }, 400));
    await expect(refreshAccessToken(credentials, { refreshToken: 'rt' })).rejects.toMatchObject({
      name: 'GmailOAuthError',
      code: 'invalid_grant',
      status: 400,
      message: 'Token refresh failed: Token has been revoked.',
    });
  });

  it('keeps a generic server_error for a non-JSON failure', async () => {
    fetchMock.mockResolvedValue(new Response('bad gateway', { status: 502 }));
    const err = await exchangeCode(credentials, { code: 'c', codeVerifier: 'v', redirectUri: 'r' }).catch((e) => e);
    expect(err).toBeInstanceOf(GmailOAuthError);
    expect(err.code).toBe('server_error');
  });

  it('rejects a token response with no access token', async () => {
    fetchMock.mockResolvedValue(json({ expires_in: 10 }));
    await expect(refreshAccessToken(credentials, { refreshToken: 'rt' })).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('revokes best effort and never throws', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(revokeToken({ token: 'rt' })).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]![0]).toBe('https://oauth2.googleapis.com/revoke');
  });
});
