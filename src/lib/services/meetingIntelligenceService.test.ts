import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TokenCipher } from '@/lib/crypto/tokenCipher';
import {
  McpUnauthorizedError,
  MeetingIntelligenceOAuthError,
  meetingIntelligenceEndpoints,
  type McpToolResult,
} from '@/lib/meetingIntelligence';
import type {
  MeetingIntelligenceConnectionRow,
  MeetingIntelligenceRepository,
  RefreshedMeetingIntelligenceTokens,
  UpsertMeetingIntelligenceConnection,
} from '@/lib/repositories/meetingIntelligenceRepository';
import {
  MeetingIntelligenceAuthorizationError,
  MeetingIntelligenceNotConnectedError,
  MeetingIntelligenceRefreshPendingError,
  MeetingIntelligenceService,
  type MeetingIntelligenceHttp,
} from './meetingIntelligenceService';

const NOW = Date.parse('2026-10-28T00:00:00Z');
const endpoints = meetingIntelligenceEndpoints('https://mi.test');
const tokenCipher = new TokenCipher('t', 'secret');
const stateCipher = new TokenCipher('s', 'secret');

/**
 * In-memory stand-in for the repository, honouring the lease semantics the
 * real conditional UPDATE gives (one claimer at a time until it expires or is
 * released).
 */
class FakeRepo {
  clients = new Map<string, string>();
  connections = new Map<string, MeetingIntelligenceConnectionRow>();
  now = NOW;

  async findClientId(server: string, redirect: string) {
    return this.clients.get(`${server}|${redirect}`) ?? null;
  }
  async saveClientId(server: string, redirect: string, id: string) {
    this.clients.set(`${server}|${redirect}`, id);
  }
  async deleteClientId(server: string, redirect: string) {
    this.clients.delete(`${server}|${redirect}`);
  }
  async findConnection(userId: string) {
    const row = this.connections.get(userId);
    return row ? { ...row } : null;
  }
  async upsertConnection(input: UpsertMeetingIntelligenceConnection) {
    const row = {
      id: 'conn',
      user_id: input.userId,
      server_url: input.serverUrl,
      client_id: input.clientId,
      access_token_enc: input.accessTokenEnc,
      refresh_token_enc: input.refreshTokenEnc,
      access_token_expires_at: input.accessTokenExpiresAt,
      scope: input.scope,
      external_name: input.externalName,
      external_email: input.externalEmail,
      refresh_lease_until: null,
      connected_at: '2026-10-28T00:00:00Z',
      updated_at: '2026-10-28T00:00:00Z',
    } satisfies MeetingIntelligenceConnectionRow;
    this.connections.set(input.userId, row);
    return { ...row };
  }
  async claimRefreshLease(userId: string, seconds: number) {
    const row = this.connections.get(userId);
    if (!row) return null;
    if (row.refresh_lease_until && Date.parse(row.refresh_lease_until) > this.now) return null;
    row.refresh_lease_until = new Date(this.now + seconds * 1000).toISOString();
    return { ...row };
  }
  async saveRefreshedTokens(userId: string, t: RefreshedMeetingIntelligenceTokens) {
    const row = this.connections.get(userId);
    if (!row) return;
    Object.assign(row, {
      access_token_enc: t.accessTokenEnc,
      refresh_token_enc: t.refreshTokenEnc,
      access_token_expires_at: t.accessTokenExpiresAt,
      scope: t.scope,
      refresh_lease_until: null,
    });
  }
  async releaseRefreshLease(userId: string) {
    const row = this.connections.get(userId);
    if (row) row.refresh_lease_until = null;
  }
  async deleteConnection(userId: string) {
    this.connections.delete(userId);
  }
}

function okResult(data: unknown): McpToolResult {
  return { structuredContent: data, text: JSON.stringify(data), isError: false };
}

function makeHttp() {
  return {
    registerClient: vi.fn(async () => 'client-1'),
    exchangeCode: vi.fn(async () => ({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: new Date(NOW + 3600_000),
      scope: 'mcp:read',
    })),
    refreshTokens: vi.fn(),
    revokeToken: vi.fn(async () => undefined),
    callMcpTool: vi.fn(),
    listMcpTools: vi.fn(async () => []),
  } satisfies Record<keyof MeetingIntelligenceHttp, unknown>;
}

describe('MeetingIntelligenceService', () => {
  let repo: FakeRepo;
  let http: ReturnType<typeof makeHttp>;
  let service: MeetingIntelligenceService;

  beforeEach(() => {
    repo = new FakeRepo();
    http = makeHttp();
    service = new MeetingIntelligenceService(repo as unknown as MeetingIntelligenceRepository, {
      endpoints,
      http: http as unknown as MeetingIntelligenceHttp,
      tokenCipher,
      stateCipher,
      now: () => repo.now,
      sleep: async () => {
        // Let other in-flight calls progress, like a real wait would.
        await new Promise((r) => setImmediate(r));
      },
    });
  });

  /** Seed a connection whose access token expires `expiresInMs` from now. */
  function seedConnection(expiresInMs: number, access = 'at-0', refresh = 'rt-0') {
    repo.connections.set('u1', {
      id: 'conn',
      user_id: 'u1',
      server_url: 'https://mi.test',
      client_id: 'client-1',
      access_token_enc: tokenCipher.encrypt(access),
      refresh_token_enc: tokenCipher.encrypt(refresh),
      access_token_expires_at: new Date(NOW + expiresInMs).toISOString(),
      scope: 'mcp:read',
      external_name: 'Nico',
      external_email: 'nico@test',
      refresh_lease_until: null,
      connected_at: '2026-10-27T00:00:00Z',
      updated_at: '2026-10-27T00:00:00Z',
    });
  }

  describe('MeetingIntelligenceService.beginAuthorization', () => {
    it('registers a client once per redirect URI and seals the PKCE state', async () => {
      const first = await service.beginAuthorization({
        userId: 'u1',
        redirectUri: 'https://app.test/cb',
        returnTo: '/w/acme/profile',
      });
      await service.beginAuthorization({ userId: 'u1', redirectUri: 'https://app.test/cb', returnTo: '/' });

      expect(http.registerClient).toHaveBeenCalledTimes(1);
      const url = new URL(first.authorizeUrl);
      expect(url.searchParams.get('client_id')).toBe('client-1');
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(first.sealedState).not.toContain(url.searchParams.get('state'));

      const pending = service.openPendingAuthorization(first.sealedState);
      expect(pending).toMatchObject({
        userId: 'u1',
        state: url.searchParams.get('state'),
        clientId: 'client-1',
        redirectUri: 'https://app.test/cb',
        returnTo: '/w/acme/profile',
      });
    });

    it('propagates an unwhitelisted redirect domain', async () => {
      http.registerClient.mockRejectedValueOnce(
        new MeetingIntelligenceOAuthError('invalid_redirect_uri', 'nope', 400),
      );
      await expect(
        service.beginAuthorization({ userId: 'u1', redirectUri: 'https://x.test/cb', returnTo: '/' }),
      ).rejects.toMatchObject({ code: 'invalid_redirect_uri' });
    });
  });

  describe('MeetingIntelligenceService.openPendingAuthorization', () => {
    it('rejects a missing, tampered or expired state', async () => {
      const { sealedState } = await service.beginAuthorization({
        userId: 'u1',
        redirectUri: 'https://app.test/cb',
        returnTo: '/',
      });
      expect(service.openPendingAuthorization(undefined)).toBeNull();
      expect(service.openPendingAuthorization(`${sealedState}x`)).toBeNull();
      repo.now = NOW + 11 * 60_000;
      expect(service.openPendingAuthorization(sealedState)).toBeNull();
    });
  });

  describe('MeetingIntelligenceService.completeAuthorization', () => {
    async function pending() {
      const { sealedState, authorizeUrl } = await service.beginAuthorization({
        userId: 'u1',
        redirectUri: 'https://app.test/cb',
        returnTo: '/',
      });
      return {
        pending: service.openPendingAuthorization(sealedState)!,
        state: new URL(authorizeUrl).searchParams.get('state')!,
      };
    }

    it('exchanges the code and stores encrypted tokens with the whoami identity', async () => {
      http.callMcpTool.mockResolvedValueOnce(okResult({ name: 'Nico', email: 'nico@test' }));
      const p = await pending();

      const status = await service.completeAuthorization({ userId: 'u1', ...p, code: 'code-1' });

      expect(status).toMatchObject({ connected: true, externalName: 'Nico', externalEmail: 'nico@test' });
      expect(http.exchangeCode).toHaveBeenCalledWith(endpoints, {
        clientId: 'client-1',
        code: 'code-1',
        codeVerifier: p.pending.codeVerifier,
        redirectUri: 'https://app.test/cb',
      });
      const row = repo.connections.get('u1')!;
      expect(row.access_token_enc).not.toContain('at-1');
      expect(tokenCipher.decrypt(row.access_token_enc)).toBe('at-1');
      expect(tokenCipher.decrypt(row.refresh_token_enc)).toBe('rt-1');
    });

    it('still connects when whoami fails', async () => {
      http.callMcpTool.mockRejectedValueOnce(new Error('boom'));
      const p = await pending();
      const status = await service.completeAuthorization({ userId: 'u1', ...p, code: 'c' });
      expect(status).toMatchObject({ connected: true, externalName: null });
    });

    it('refuses a state mismatch or a different user', async () => {
      const p = await pending();
      await expect(
        service.completeAuthorization({ userId: 'u1', pending: p.pending, state: 'forged', code: 'c' }),
      ).rejects.toBeInstanceOf(MeetingIntelligenceAuthorizationError);
      await expect(
        service.completeAuthorization({ userId: 'u2', ...p, code: 'c' }),
      ).rejects.toBeInstanceOf(MeetingIntelligenceAuthorizationError);
      expect(http.exchangeCode).not.toHaveBeenCalled();
    });

    it('forgets the client registration when the server no longer knows it', async () => {
      http.exchangeCode.mockRejectedValueOnce(new MeetingIntelligenceOAuthError('invalid_client', 'x', 400));
      const p = await pending();
      await expect(service.completeAuthorization({ userId: 'u1', ...p, code: 'c' })).rejects.toBeInstanceOf(
        MeetingIntelligenceAuthorizationError,
      );
      expect(await repo.findClientId('https://mi.test', 'https://app.test/cb')).toBeNull();
    });
  });

  describe('MeetingIntelligenceService.callTool', () => {
    it('throws not_connected when the user never connected', async () => {
      await expect(service.callTool('u1', 'whoami', {})).rejects.toMatchObject({
        name: 'MeetingIntelligenceNotConnectedError',
        reason: 'not_connected',
      });
    });

    it('uses a still-valid access token without refreshing', async () => {
      seedConnection(30 * 60_000);
      http.callMcpTool.mockResolvedValueOnce(okResult({ ok: 1 }));

      await service.callTool('u1', 'get_my_action_items', { status: 'delayed' });

      expect(http.callMcpTool).toHaveBeenCalledWith(endpoints, 'at-0', 'get_my_action_items', {
        status: 'delayed',
      });
      expect(http.refreshTokens).not.toHaveBeenCalled();
    });

    it('refreshes an expiring token first and stores the rotated pair', async () => {
      seedConnection(30_000);
      http.refreshTokens.mockResolvedValueOnce({
        accessToken: 'at-2',
        refreshToken: 'rt-2',
        expiresAt: new Date(NOW + 3600_000),
        scope: 'mcp:read',
      });
      http.callMcpTool.mockResolvedValueOnce(okResult({}));

      await service.callTool('u1', 'whoami', {});

      expect(http.refreshTokens).toHaveBeenCalledWith(endpoints, { clientId: 'client-1', refreshToken: 'rt-0' });
      expect(http.callMcpTool).toHaveBeenCalledWith(endpoints, 'at-2', 'whoami', {});
      const row = repo.connections.get('u1')!;
      expect(tokenCipher.decrypt(row.refresh_token_enc)).toBe('rt-2');
      expect(row.refresh_lease_until).toBeNull();
    });

    it('refreshes only once when concurrent calls find the token expired', async () => {
      seedConnection(0);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      http.refreshTokens.mockImplementation(async () => {
        await gate;
        return { accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: new Date(NOW + 3600_000), scope: null };
      });
      http.callMcpTool.mockResolvedValue(okResult({}));

      const calls = [service.callTool('u1', 'whoami', {}), service.callTool('u1', 'list_meetings', {})];
      await new Promise((r) => setImmediate(r));
      release();
      await Promise.all(calls);

      expect(http.refreshTokens).toHaveBeenCalledTimes(1);
      expect(http.callMcpTool.mock.calls.map((c) => c[1])).toEqual(['at-2', 'at-2']);
    });

    it('reuses a refresh another request finished while it waited', async () => {
      seedConnection(0);
      // Someone else holds the lease; they finish after a few polls.
      repo.connections.get('u1')!.refresh_lease_until = new Date(NOW + 30_000).toISOString();
      let polls = 0;
      const realFind = repo.findConnection.bind(repo);
      repo.findConnection = async (userId: string) => {
        if (++polls === 4) {
          await repo.saveRefreshedTokens('u1', {
            accessTokenEnc: tokenCipher.encrypt('at-other'),
            refreshTokenEnc: tokenCipher.encrypt('rt-other'),
            accessTokenExpiresAt: new Date(NOW + 3600_000).toISOString(),
            scope: null,
          });
        }
        return realFind(userId);
      };
      http.callMcpTool.mockResolvedValue(okResult({}));

      await service.callTool('u1', 'whoami', {});

      expect(http.refreshTokens).not.toHaveBeenCalled();
      expect(http.callMcpTool).toHaveBeenCalledWith(endpoints, 'at-other', 'whoami', {});
    });

    it('gives up with a typed transient error when the other refresh never finishes', async () => {
      seedConnection(0);
      repo.connections.get('u1')!.refresh_lease_until = new Date(NOW + 30_000).toISOString();

      await expect(service.callTool('u1', 'whoami', {})).rejects.toBeInstanceOf(
        MeetingIntelligenceRefreshPendingError,
      );
      expect(http.refreshTokens).not.toHaveBeenCalled();
    });

    it('refreshes and retries once on a 401', async () => {
      seedConnection(30 * 60_000);
      http.callMcpTool.mockRejectedValueOnce(new McpUnauthorizedError()).mockResolvedValueOnce(okResult({ ok: 1 }));
      http.refreshTokens.mockResolvedValueOnce({
        accessToken: 'at-2',
        refreshToken: 'rt-2',
        expiresAt: new Date(NOW + 3600_000),
        scope: null,
      });

      const result = await service.callTool('u1', 'whoami', {});

      expect(result.structuredContent).toEqual({ ok: 1 });
      expect(http.callMcpTool.mock.calls.map((c) => c[1])).toEqual(['at-0', 'at-2']);
    });

    it('disconnects when the refresh token is spent (invalid_grant)', async () => {
      seedConnection(0);
      http.refreshTokens.mockRejectedValueOnce(new MeetingIntelligenceOAuthError('invalid_grant', 'x', 400));

      await expect(service.callTool('u1', 'whoami', {})).rejects.toMatchObject({ reason: 'expired' });
      expect(repo.connections.has('u1')).toBe(false);
    });

    it('keeps the connection and releases the lease on a transient refresh failure', async () => {
      seedConnection(0);
      http.refreshTokens.mockRejectedValueOnce(new Error('network down'));

      await expect(service.callTool('u1', 'whoami', {})).rejects.toThrow('network down');
      expect(repo.connections.get('u1')!.refresh_lease_until).toBeNull();
    });

    it('disconnects when even a fresh token gets a 401', async () => {
      seedConnection(30 * 60_000);
      http.callMcpTool.mockRejectedValue(new McpUnauthorizedError());
      http.refreshTokens.mockResolvedValueOnce({
        accessToken: 'at-2',
        refreshToken: 'rt-2',
        expiresAt: new Date(NOW + 3600_000),
        scope: null,
      });

      await expect(service.callTool('u1', 'whoami', {})).rejects.toBeInstanceOf(
        MeetingIntelligenceNotConnectedError,
      );
      expect(repo.connections.has('u1')).toBe(false);
    });

    it('treats undecryptable tokens (rotated AUTH_SECRET) as disconnected', async () => {
      seedConnection(30 * 60_000);
      repo.connections.get('u1')!.access_token_enc = new TokenCipher('t', 'old-secret').encrypt('at-0');

      await expect(service.callTool('u1', 'whoami', {})).rejects.toMatchObject({ reason: 'expired' });
      expect(repo.connections.has('u1')).toBe(false);
    });
  });

  describe('MeetingIntelligenceService.disconnect', () => {
    it('revokes the refresh token and deletes the connection', async () => {
      seedConnection(30 * 60_000);
      await service.disconnect('u1');
      expect(http.revokeToken).toHaveBeenCalledWith(endpoints, { clientId: 'client-1', token: 'rt-0' });
      expect(repo.connections.has('u1')).toBe(false);
    });

    it('is a no-op when not connected', async () => {
      await service.disconnect('u1');
      expect(http.revokeToken).not.toHaveBeenCalled();
    });
  });

  describe('MeetingIntelligenceService.getStatus', () => {
    it('reports the connected identity', async () => {
      seedConnection(30 * 60_000);
      expect(await service.getStatus('u1')).toEqual({
        connected: true,
        externalName: 'Nico',
        externalEmail: 'nico@test',
        connectedAt: '2026-10-27T00:00:00Z',
      });
      expect((await service.getStatus('u2')).connected).toBe(false);
    });
  });
});
