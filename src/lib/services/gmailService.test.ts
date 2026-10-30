import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { TokenCipher } from '@/lib/crypto/tokenCipher';
import { GMAIL_COMPOSE_SCOPE, GMAIL_SCOPE, GmailApiError, GmailOAuthError, GmailUnauthorizedError } from '@/lib/gmail';
import type {
  GmailConnectionRow,
  GmailRepository,
  RefreshedGmailTokens,
  UpsertGmailConnection,
} from '@/lib/repositories/gmailRepository';
import {
  GmailAuthorizationError,
  GmailNotConfiguredError,
  GmailNotConnectedError,
  GmailScopeMissingError,
  GmailService,
  type GmailHttp,
} from './gmailService';

const NOW = Date.parse('2026-10-29T00:00:00Z');
const credentials = { clientId: 'cid', clientSecret: 'csecret' };
const tokenCipher = new TokenCipher('t', 'secret');
const stateCipher = new TokenCipher('s', 'secret');

class FakeRepo {
  connections = new Map<string, GmailConnectionRow>();

  async findConnection(userId: string) {
    const row = this.connections.get(userId);
    return row ? { ...row } : null;
  }
  async upsertConnection(input: UpsertGmailConnection) {
    const row: GmailConnectionRow = {
      id: 'conn',
      user_id: input.userId,
      access_token_enc: input.accessTokenEnc,
      refresh_token_enc: input.refreshTokenEnc,
      access_token_expires_at: input.accessTokenExpiresAt,
      scope: input.scope,
      google_email: input.googleEmail,
      connected_at: new Date(NOW).toISOString(),
      updated_at: new Date(NOW).toISOString(),
    };
    this.connections.set(input.userId, row);
    return { ...row };
  }
  async saveRefreshedTokens(userId: string, tokens: RefreshedGmailTokens) {
    const row = this.connections.get(userId);
    if (!row) return;
    row.access_token_enc = tokens.accessTokenEnc;
    if (tokens.refreshTokenEnc) row.refresh_token_enc = tokens.refreshTokenEnc;
    row.access_token_expires_at = tokens.accessTokenExpiresAt;
  }
  async deleteConnection(userId: string) {
    this.connections.delete(userId);
  }
}

/** Every GmailHttp method as a vitest mock, so tests can script and inspect each call. */
type MockHttp = { [K in keyof GmailHttp]: Mock };

function makeHttp(): MockHttp {
  return {
    exchangeCode: vi.fn(),
    refreshAccessToken: vi.fn(),
    revokeToken: vi.fn(async () => undefined),
    getProfile: vi.fn(async () => ({ emailAddress: 'me@gmail.com' })),
    searchMessages: vi.fn(),
    getMessage: vi.fn(),
    getThread: vi.fn(),
    createDraft: vi.fn(),
  };
}

function setup(opts: { credentials?: typeof credentials | null } = {}) {
  const repo = new FakeRepo();
  const http = makeHttp();
  const service = new GmailService(repo as unknown as GmailRepository, {
    credentials: opts.credentials === undefined ? credentials : opts.credentials,
    http: http as unknown as GmailHttp,
    tokenCipher,
    stateCipher,
    now: () => NOW,
  });
  return { repo, http, service };
}

function seedConnection(repo: FakeRepo, over: Partial<GmailConnectionRow> = {}) {
  repo.connections.set('u1', {
    id: 'conn',
    user_id: 'u1',
    access_token_enc: tokenCipher.encrypt('access-1'),
    refresh_token_enc: tokenCipher.encrypt('refresh-1'),
    access_token_expires_at: new Date(NOW + 30 * 60_000).toISOString(),
    scope: GMAIL_SCOPE,
    google_email: 'me@gmail.com',
    connected_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    ...over,
  });
}

const grantedTokens = (over: Record<string, unknown> = {}) => ({
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: new Date(NOW + 3_600_000),
  scope: GMAIL_SCOPE,
  ...over,
});

describe('GmailService.beginAuthorization / completeAuthorization', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  const begin = () =>
    ctx.service.beginAuthorization({ userId: 'u1', redirectUri: 'https://app.test/cb', returnTo: '/w/a/profile' });

  it('builds Google’s URL and seals the state, never exposing the PKCE verifier', () => {
    const { authorizeUrl, sealedState } = begin();
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.test/cb');
    const pending = ctx.service.openPendingAuthorization(sealedState)!;
    expect(pending.state).toBe(url.searchParams.get('state'));
    expect(authorizeUrl).not.toContain(pending.codeVerifier);
    expect(sealedState).not.toContain(pending.codeVerifier);
  });

  it('refuses to start without a Google client configured', () => {
    const { service } = setup({ credentials: null });
    expect(service.isConfigured()).toBe(false);
    expect(() => service.beginAuthorization({ userId: 'u1', redirectUri: 'r', returnTo: '/' })).toThrow(
      GmailNotConfiguredError,
    );
  });

  it('stores encrypted tokens and the mailbox address on a successful callback', async () => {
    const { sealedState } = begin();
    const pending = ctx.service.openPendingAuthorization(sealedState)!;
    ctx.http.exchangeCode.mockResolvedValue(grantedTokens());

    const status = await ctx.service.completeAuthorization({ userId: 'u1', pending, state: pending.state, code: 'code' });

    expect(ctx.http.exchangeCode).toHaveBeenCalledWith(credentials, {
      code: 'code',
      codeVerifier: pending.codeVerifier,
      redirectUri: 'https://app.test/cb',
    });
    expect(status).toMatchObject({ connected: true, googleEmail: 'me@gmail.com' });
    const row = ctx.repo.connections.get('u1')!;
    expect(row.access_token_enc).not.toContain('access-1');
    expect(tokenCipher.decrypt(row.refresh_token_enc)).toBe('refresh-1');
  });

  it('connects read-only when the member unticks draft access, and says it cannot draft', async () => {
    const { sealedState } = begin();
    const pending = ctx.service.openPendingAuthorization(sealedState)!;
    ctx.http.exchangeCode.mockResolvedValue(grantedTokens());
    const readOnly = await ctx.service.completeAuthorization({ userId: 'u1', pending, state: pending.state, code: 'c' });
    expect(readOnly.canDraft).toBe(false);

    ctx.http.exchangeCode.mockResolvedValue(grantedTokens({ scope: `${GMAIL_SCOPE} ${GMAIL_COMPOSE_SCOPE}` }));
    const full = await ctx.service.completeAuthorization({ userId: 'u1', pending, state: pending.state, code: 'c' });
    expect(full.canDraft).toBe(true);
    expect(ctx.repo.connections.get('u1')!.scope).toContain(GMAIL_COMPOSE_SCOPE);
  });

  it('still connects when the mailbox address cannot be read', async () => {
    const { sealedState } = begin();
    const pending = ctx.service.openPendingAuthorization(sealedState)!;
    ctx.http.exchangeCode.mockResolvedValue(grantedTokens());
    ctx.http.getProfile.mockRejectedValue(new Error('boom'));
    const status = await ctx.service.completeAuthorization({ userId: 'u1', pending, state: pending.state, code: 'c' });
    expect(status).toMatchObject({ connected: true, googleEmail: null });
  });

  it('rejects a callback started by another user or with a mismatched state, without exchanging the code', async () => {
    const { sealedState } = begin();
    const pending = ctx.service.openPendingAuthorization(sealedState)!;
    await expect(
      ctx.service.completeAuthorization({ userId: 'u2', pending, state: pending.state, code: 'c' }),
    ).rejects.toThrow(GmailAuthorizationError);
    await expect(
      ctx.service.completeAuthorization({ userId: 'u1', pending, state: 'forged', code: 'c' }),
    ).rejects.toThrow(GmailAuthorizationError);
    expect(ctx.http.exchangeCode).not.toHaveBeenCalled();
  });

  it('stores nothing and revokes the grant when the member left the Gmail permission unticked', async () => {
    const { sealedState } = begin();
    const pending = ctx.service.openPendingAuthorization(sealedState)!;
    ctx.http.exchangeCode.mockResolvedValue(grantedTokens({ scope: 'openid email' }));

    await expect(
      ctx.service.completeAuthorization({ userId: 'u1', pending, state: pending.state, code: 'c' }),
    ).rejects.toMatchObject({ reason: 'missing_scope' });

    expect(ctx.repo.connections.size).toBe(0);
    expect(ctx.http.revokeToken).toHaveBeenCalledWith({ token: 'refresh-1' });
  });

  it('stores nothing when Google sends no refresh token, since the connection would die within the hour', async () => {
    const { sealedState } = begin();
    const pending = ctx.service.openPendingAuthorization(sealedState)!;
    ctx.http.exchangeCode.mockResolvedValue(grantedTokens({ refreshToken: null }));

    await expect(
      ctx.service.completeAuthorization({ userId: 'u1', pending, state: pending.state, code: 'c' }),
    ).rejects.toMatchObject({ reason: 'no_refresh_token' });
    expect(ctx.repo.connections.size).toBe(0);
  });

  it('wraps a failed code exchange as an authorization error', async () => {
    const { sealedState } = begin();
    const pending = ctx.service.openPendingAuthorization(sealedState)!;
    ctx.http.exchangeCode.mockRejectedValue(new GmailOAuthError('invalid_grant', 'Bad code', 400));
    await expect(
      ctx.service.completeAuthorization({ userId: 'u1', pending, state: pending.state, code: 'c' }),
    ).rejects.toThrow(GmailAuthorizationError);
  });

  it('opens no state that decrypts but is missing a field the callback relies on', () => {
    const { service } = setup();
    const partial = stateCipher.encrypt(JSON.stringify({ state: 's', issuedAt: NOW, userId: 'u1' }));
    expect(service.openPendingAuthorization(partial)).toBeNull();
  });

  it('opens no state that is missing, tampered with or older than 10 minutes', () => {
    const { sealedState } = begin();
    expect(ctx.service.openPendingAuthorization(undefined)).toBeNull();
    expect(ctx.service.openPendingAuthorization(`${sealedState}x`)).toBeNull();
    const later = new GmailService(ctx.repo as unknown as GmailRepository, {
      credentials,
      http: ctx.http as unknown as GmailHttp,
      tokenCipher,
      stateCipher,
      now: () => NOW + 11 * 60_000,
    });
    expect(later.openPendingAuthorization(sealedState)).toBeNull();
  });
});

describe('GmailService.getStatus / disconnect', () => {
  it('reports connected state and the address, and not-connected for a stranger', async () => {
    const { repo, service } = setup();
    seedConnection(repo);
    expect(await service.getStatus('u1')).toMatchObject({ connected: true, googleEmail: 'me@gmail.com' });
    expect(await service.getStatus('u2')).toEqual({
      connected: false,
      googleEmail: null,
      connectedAt: null,
      canDraft: false,
    });
  });

  it('says whether the connection can save drafts: only a grant that includes the compose scope can', async () => {
    const { repo, service } = setup();
    seedConnection(repo);
    expect((await service.getStatus('u1')).canDraft).toBe(false);
    seedConnection(repo, { scope: `${GMAIL_SCOPE} ${GMAIL_COMPOSE_SCOPE}` });
    expect((await service.getStatus('u1')).canDraft).toBe(true);
  });

  it('revokes the refresh token with Google, then deletes the row', async () => {
    const { repo, http, service } = setup();
    seedConnection(repo);
    await service.disconnect('u1');
    expect(http.revokeToken).toHaveBeenCalledWith({ token: 'refresh-1' });
    expect(repo.connections.has('u1')).toBe(false);
  });

  it('deletes the row even when the stored tokens cannot be decrypted', async () => {
    const { repo, http, service } = setup();
    seedConnection(repo, { refresh_token_enc: 'garbage' });
    await service.disconnect('u1');
    expect(http.revokeToken).not.toHaveBeenCalled();
    expect(repo.connections.has('u1')).toBe(false);
  });

  it('is a no-op for a member who never connected', async () => {
    const { http, service } = setup();
    await service.disconnect('u1');
    expect(http.revokeToken).not.toHaveBeenCalled();
  });
});

describe('GmailService reads', () => {
  it('searches as the member with the stored access token', async () => {
    const { repo, http, service } = setup();
    seedConnection(repo);
    http.searchMessages.mockResolvedValue({ messages: [], hasMore: false });

    await service.search('u1', { query: 'is:unread', maxResults: 5 });

    expect(http.searchMessages).toHaveBeenCalledWith('access-1', { query: 'is:unread', maxResults: 5 });
    expect(http.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('routes read_message and read_thread through the same token handling', async () => {
    const { repo, http, service } = setup();
    seedConnection(repo);
    http.getMessage.mockResolvedValue({ id: 'm1' });
    http.getThread.mockResolvedValue({ messages: [], totalMessages: 0 });
    await service.readMessage('u1', 'm1');
    await service.readThread('u1', 't1');
    expect(http.getMessage).toHaveBeenCalledWith('access-1', 'm1');
    expect(http.getThread).toHaveBeenCalledWith('access-1', 't1');
  });

  it('is not connected for a member with no row', async () => {
    const { http, service } = setup();
    await expect(service.search('u1', { query: '' })).rejects.toMatchObject({
      name: 'GmailNotConnectedError',
      reason: 'not_connected',
    });
    expect(http.searchMessages).not.toHaveBeenCalled();
  });

  it('one member can never read through another member’s connection', async () => {
    const { repo, http, service } = setup();
    seedConnection(repo);
    await expect(service.search('someone-else', { query: '' })).rejects.toBeInstanceOf(GmailNotConnectedError);
    expect(http.searchMessages).not.toHaveBeenCalled();
  });

  it('passes other API errors through untouched', async () => {
    const { repo, http, service } = setup();
    seedConnection(repo);
    const err = new GmailApiError(429, 'slow down', 5);
    http.searchMessages.mockRejectedValue(err);
    await expect(service.search('u1', { query: '' })).rejects.toBe(err);
  });
});

describe('GmailService.createDraft', () => {
  const draft = { to: ['ana@example.com'], subject: 'Q3 numbers', text: 'Hi Ana', html: '<p>Hi Ana</p>' };
  const withCompose = { scope: `${GMAIL_SCOPE} ${GMAIL_COMPOSE_SCOPE}` };

  it('saves a draft as the member and reports where it landed', async () => {
    const { repo, http, service } = setup();
    seedConnection(repo, withCompose);
    http.createDraft.mockResolvedValue({ draftId: 'r1', messageId: 'm1', threadId: 't1' });

    const result = await service.createDraft('u1', draft);

    expect(result).toEqual({ draftId: 'r1', messageId: 'm1', threadId: 't1', googleEmail: 'me@gmail.com' });
    const [token, raw] = http.createDraft.mock.calls[0]!;
    expect(token).toBe('access-1');
    const mime = Buffer.from(raw as string, 'base64url').toString('utf-8');
    expect(mime).toContain('To: ana@example.com');
    expect(mime).toContain('Subject: Q3 numbers');
  });

  it('needs the compose permission: a read-only connection is told to reconnect, with no Google call', async () => {
    const { repo, http, service } = setup();
    seedConnection(repo);
    await expect(service.createDraft('u1', draft)).rejects.toBeInstanceOf(GmailScopeMissingError);
    expect(http.createDraft).not.toHaveBeenCalled();
    expect(http.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('is not connected for a member with no row, and never touches another member’s mailbox', async () => {
    const { repo, http, service } = setup();
    seedConnection(repo, withCompose);
    await expect(service.createDraft('u2', draft)).rejects.toBeInstanceOf(GmailNotConnectedError);
    expect(http.createDraft).not.toHaveBeenCalled();
  });

  it('rejects a recipient that is not a plain address before calling Google', async () => {
    const { repo, http, service } = setup();
    seedConnection(repo, withCompose);
    await expect(service.createDraft('u1', { ...draft, to: ['a@b.com, evil@x.com'] })).rejects.toThrow(
      /plain email address/,
    );
    expect(http.createDraft).not.toHaveBeenCalled();
  });

  it('refreshes an expiring token first, and retries once on a 401', async () => {
    const { repo, http, service } = setup();
    seedConnection(repo, { ...withCompose, access_token_expires_at: new Date(NOW + 10_000).toISOString() });
    http.refreshAccessToken.mockResolvedValue({
      accessToken: 'access-2',
      refreshToken: null,
      expiresAt: new Date(NOW + 3_600_000),
      scope: null,
    });
    http.createDraft.mockRejectedValueOnce(new GmailUnauthorizedError());
    http.createDraft.mockResolvedValueOnce({ draftId: 'r2', messageId: null, threadId: null });

    const result = await service.createDraft('u1', draft);

    expect(result.draftId).toBe('r2');
    expect(http.createDraft.mock.calls.map((c) => c[0])).toEqual(['access-2', 'access-2']);
  });
});

describe('GmailService token refresh', () => {
  it('refreshes an expiring access token first and stores the new one, keeping the refresh token', async () => {
    const { repo, http, service } = setup();
    seedConnection(repo, { access_token_expires_at: new Date(NOW + 10_000).toISOString() });
    http.refreshAccessToken.mockResolvedValue({
      accessToken: 'access-2',
      refreshToken: null,
      expiresAt: new Date(NOW + 3_600_000),
      scope: null,
    });
    http.searchMessages.mockResolvedValue({ messages: [], hasMore: false });

    await service.search('u1', { query: '' });

    expect(http.refreshAccessToken).toHaveBeenCalledWith(credentials, { refreshToken: 'refresh-1' });
    expect(http.searchMessages).toHaveBeenCalledWith('access-2', expect.anything());
    const row = repo.connections.get('u1')!;
    expect(tokenCipher.decrypt(row.access_token_enc)).toBe('access-2');
    expect(tokenCipher.decrypt(row.refresh_token_enc)).toBe('refresh-1');
  });

  it('stores a rotated refresh token if Google ever sends one', async () => {
    const { repo, http, service } = setup();
    seedConnection(repo, { access_token_expires_at: new Date(NOW).toISOString() });
    http.refreshAccessToken.mockResolvedValue({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      expiresAt: new Date(NOW + 3_600_000),
      scope: null,
    });
    http.getMessage.mockResolvedValue({ id: 'm' });
    await service.readMessage('u1', 'm');
    expect(tokenCipher.decrypt(repo.connections.get('u1')!.refresh_token_enc)).toBe('refresh-2');
  });

  it('refreshes once and retries when Gmail answers 401 on a token it thought was fresh', async () => {
    const { repo, http, service } = setup();
    seedConnection(repo);
    http.refreshAccessToken.mockResolvedValue({
      accessToken: 'access-2',
      refreshToken: null,
      expiresAt: new Date(NOW + 3_600_000),
      scope: null,
    });
    http.getMessage.mockRejectedValueOnce(new GmailUnauthorizedError()).mockResolvedValueOnce({ id: 'm' });

    expect(await service.readMessage('u1', 'm')).toEqual({ id: 'm' });
    expect(http.getMessage).toHaveBeenNthCalledWith(1, 'access-1', 'm');
    expect(http.getMessage).toHaveBeenNthCalledWith(2, 'access-2', 'm');
    expect(http.refreshAccessToken).toHaveBeenCalledTimes(1);
  });

  it('disconnects the member when even a fresh token is refused', async () => {
    const { repo, http, service } = setup();
    seedConnection(repo);
    http.refreshAccessToken.mockResolvedValue({
      accessToken: 'access-2',
      refreshToken: null,
      expiresAt: new Date(NOW + 3_600_000),
      scope: null,
    });
    http.getMessage.mockRejectedValue(new GmailUnauthorizedError());

    await expect(service.readMessage('u1', 'm')).rejects.toMatchObject({ reason: 'expired' });
    expect(repo.connections.has('u1')).toBe(false);
  });

  it('deletes the connection when Google says the grant is gone (revoked, or 7-day Testing expiry)', async () => {
    const { repo, http, service } = setup();
    seedConnection(repo, { access_token_expires_at: new Date(NOW).toISOString() });
    http.refreshAccessToken.mockRejectedValue(new GmailOAuthError('invalid_grant', 'revoked', 400));

    await expect(service.search('u1', { query: '' })).rejects.toMatchObject({ reason: 'expired' });
    expect(repo.connections.has('u1')).toBe(false);
  });

  it('keeps the connection when OUR client credentials are wrong or Google is down', async () => {
    const { repo, http, service } = setup();
    seedConnection(repo, { access_token_expires_at: new Date(NOW).toISOString() });

    http.refreshAccessToken.mockRejectedValueOnce(new GmailOAuthError('invalid_client', 'bad secret', 401));
    await expect(service.search('u1', { query: '' })).rejects.toMatchObject({ code: 'invalid_client' });
    http.refreshAccessToken.mockRejectedValueOnce(new GmailOAuthError('server_error', 'down', 503));
    await expect(service.search('u1', { query: '' })).rejects.toMatchObject({ code: 'server_error' });

    expect(repo.connections.has('u1')).toBe(true);
  });

  it('treats tokens it cannot decrypt (AUTH_SECRET rotated) as an expired connection', async () => {
    const { repo, http, service } = setup();
    seedConnection(repo, { access_token_enc: 'v1.bad.bad.bad' });
    await expect(service.search('u1', { query: '' })).rejects.toMatchObject({ reason: 'expired' });
    expect(repo.connections.has('u1')).toBe(false);
    expect(http.searchMessages).not.toHaveBeenCalled();
  });
});
