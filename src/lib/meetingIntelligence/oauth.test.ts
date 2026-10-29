import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meetingIntelligenceEndpoints } from './config';
import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  MeetingIntelligenceOAuthError,
  refreshTokens,
  registerClient,
  revokeToken,
} from './oauth';

const endpoints = meetingIntelligenceEndpoints('https://mi.test/');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('meetingIntelligenceEndpoints', () => {
  it('derives every endpoint from the base URL, without a trailing slash', () => {
    expect(endpoints.serverUrl).toBe('https://mi.test');
    expect(endpoints.mcp).toBe('https://mi.test/api/mcp');
    expect(endpoints.token).toBe('https://mi.test/api/oauth/token');
  });
});

describe('generatePkce', () => {
  it('returns a 43-char verifier and its S256 challenge', () => {
    const { codeVerifier, codeChallenge } = generatePkce();
    expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codeChallenge).toBe(createHash('sha256').update(codeVerifier).digest('base64url'));
  });
});

describe('buildAuthorizeUrl', () => {
  it('sends S256 PKCE, the read scope and the MCP resource', () => {
    const url = new URL(
      buildAuthorizeUrl(endpoints, {
        clientId: 'c1',
        redirectUri: 'https://app.test/cb',
        codeChallenge: 'chal',
        state: 'st',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://mi.test/api/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'c1',
      redirect_uri: 'https://app.test/cb',
      code_challenge: 'chal',
      code_challenge_method: 'S256',
      state: 'st',
      scope: 'mcp:read',
      resource: 'https://mi.test/api/mcp',
    });
  });
});

describe('oauth HTTP calls', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('registerClient registers a public client and returns its client_id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ client_id: 'abc' }, 201));
    await expect(registerClient(endpoints, 'https://app.test/cb')).resolves.toBe('abc');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://mi.test/api/oauth/register');
    const body = JSON.parse(init.body as string);
    expect(body.redirect_uris).toEqual(['https://app.test/cb']);
    expect(body.token_endpoint_auth_method).toBe('none');
  });

  it('registerClient surfaces the server error code (an unwhitelisted domain)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'invalid_redirect_uri', error_description: 'https://x.test/cb' }, 400),
    );
    const err = await registerClient(endpoints, 'https://x.test/cb').catch((e) => e);
    expect(err).toBeInstanceOf(MeetingIntelligenceOAuthError);
    expect(err.code).toBe('invalid_redirect_uri');
  });

  it('exchangeCode posts the code and verifier as a form and computes the expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T00:00:00Z'));
    fetchMock.mockResolvedValue(
      jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'mcp:read' }),
    );
    const tokens = await exchangeCode(endpoints, {
      clientId: 'c1',
      code: 'code',
      codeVerifier: 'ver',
      redirectUri: 'https://app.test/cb',
    });
    vi.useRealTimers();

    expect(tokens).toEqual({
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: new Date('2026-10-28T01:00:00Z'),
      scope: 'mcp:read',
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(init.body as string))).toEqual({
      grant_type: 'authorization_code',
      client_id: 'c1',
      code: 'code',
      code_verifier: 'ver',
      redirect_uri: 'https://app.test/cb',
    });
  });

  it('refreshTokens throws invalid_grant when the refresh token is spent', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400));
    const err = await refreshTokens(endpoints, { clientId: 'c1', refreshToken: 'old' }).catch((e) => e);
    expect(err).toBeInstanceOf(MeetingIntelligenceOAuthError);
    expect(err.code).toBe('invalid_grant');
    const body = new URLSearchParams(fetchMock.mock.calls[0]![1].body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old');
  });

  it('refreshTokens rejects a response with no tokens', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ token_type: 'Bearer' }));
    await expect(refreshTokens(endpoints, { clientId: 'c1', refreshToken: 'rt' })).rejects.toThrow(
      /missing tokens/,
    );
  });

  it('revokeToken never throws', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(revokeToken(endpoints, { clientId: 'c1', token: 't' })).resolves.toBeUndefined();
  });
});
