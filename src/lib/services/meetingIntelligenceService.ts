import type {
  MeetingIntelligenceConnectionRow,
  MeetingIntelligenceRepository,
} from '@/lib/repositories/meetingIntelligenceRepository';
import { TokenCipher, TokenDecryptionError } from '@/lib/crypto/tokenCipher';
import {
  buildAuthorizeUrl,
  callMcpTool,
  exchangeCode,
  generatePkce,
  generateState,
  listMcpTools,
  McpUnauthorizedError,
  MeetingIntelligenceOAuthError,
  meetingIntelligenceEndpoints,
  refreshTokens,
  registerClient,
  revokeToken,
  type McpToolDefinition,
  type McpToolResult,
  type MeetingIntelligenceEndpoints,
} from '@/lib/meetingIntelligence';

/** Refresh when the access token has less than this left. */
const REFRESH_SKEW_MS = 60_000;
/** How long one request may hold the refresh lease. */
const REFRESH_LEASE_SECONDS = 30;
/**
 * How long a request waits for another's in-flight refresh before giving up:
 * 80 × 250 ms = 20 s, longer than the 15 s OAuth timeout so a slow but
 * successful refresh is always waited out, and shorter than the 30 s lease.
 */
const REFRESH_WAIT_ATTEMPTS = 80;
const REFRESH_WAIT_MS = 250;
/** The server gives the member 10 minutes to finish signing in. */
const PENDING_AUTHORIZATION_TTL_MS = 10 * 60_000;

/**
 * The member has no usable connection: never connected, disconnected, or the
 * grant expired / was revoked (the server's 90-day cap, a reused refresh
 * token, removal from their dashboard). The fix is always the same: connect
 * again from Profile.
 */
export class MeetingIntelligenceNotConnectedError extends Error {
  constructor(readonly reason: 'not_connected' | 'expired') {
    super(
      reason === 'expired'
        ? 'The Meeting Intelligence connection has expired or was revoked'
        : 'Meeting Intelligence is not connected',
    );
    this.name = 'MeetingIntelligenceNotConnectedError';
  }
}

/**
 * Another request's token refresh was still running when this one stopped
 * waiting. Transient: the next call will find the refreshed token.
 */
export class MeetingIntelligenceRefreshPendingError extends Error {
  constructor() {
    super('Timed out waiting for the Meeting Intelligence token refresh');
    this.name = 'MeetingIntelligenceRefreshPendingError';
  }
}

/** The OAuth callback could not be completed (bad/expired state, failed exchange). */
export class MeetingIntelligenceAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeetingIntelligenceAuthorizationError';
  }
}

export interface MeetingIntelligenceStatus {
  connected: boolean;
  externalName: string | null;
  externalEmail: string | null;
  connectedAt: string | null;
}

/**
 * What must survive the browser round-trip to the authorization server. Sealed
 * (encrypted) into an httpOnly cookie by the connect route and opened by the
 * callback — the PKCE verifier never reaches the browser in the clear.
 */
export interface PendingAuthorization {
  userId: string;
  state: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  /** In-app path to land on afterwards (validated by the route). */
  returnTo: string;
  issuedAt: number;
}

/** The HTTP calls the service makes — injectable for tests. */
export interface MeetingIntelligenceHttp {
  registerClient: typeof registerClient;
  exchangeCode: typeof exchangeCode;
  refreshTokens: typeof refreshTokens;
  revokeToken: typeof revokeToken;
  callMcpTool: typeof callMcpTool;
  listMcpTools: typeof listMcpTools;
}

const defaultHttp: MeetingIntelligenceHttp = {
  registerClient,
  exchangeCode,
  refreshTokens,
  revokeToken,
  callMcpTool,
  listMcpTools,
};

export interface MeetingIntelligenceServiceOptions {
  endpoints?: MeetingIntelligenceEndpoints;
  http?: MeetingIntelligenceHttp;
  tokenCipher?: TokenCipher;
  stateCipher?: TokenCipher;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The Meeting Intelligence (MoM AI Intelligent) integration: connecting a
 * member over OAuth, keeping their tokens fresh, and calling the read-only MCP
 * tools as them. See docs/features/meeting-intelligence.md.
 *
 * Token rules the server enforces, and how they are honoured here:
 * - Refresh tokens rotate on every refresh and reusing an old one disconnects
 *   the member — so only one request refreshes at a time
 *   (`claimRefreshLease`), and the others wait for and reuse its result.
 * - A refresh failing with `invalid_grant` means the grant is gone — the
 *   connection row is deleted and the member must connect again.
 * - Tokens are stored encrypted and never logged.
 */
export class MeetingIntelligenceService {
  private readonly endpoints: MeetingIntelligenceEndpoints;
  private readonly http: MeetingIntelligenceHttp;
  private readonly options: MeetingIntelligenceServiceOptions;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tokenCipherInstance: TokenCipher | undefined;
  private stateCipherInstance: TokenCipher | undefined;

  constructor(
    private readonly repo: MeetingIntelligenceRepository,
    options: MeetingIntelligenceServiceOptions = {},
  ) {
    this.options = options;
    this.endpoints = options.endpoints ?? meetingIntelligenceEndpoints();
    this.http = options.http ?? defaultHttp;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  // Built on first use so constructing the container never needs AUTH_SECRET.
  private get tokenCipher(): TokenCipher {
    this.tokenCipherInstance ??= this.options.tokenCipher ?? new TokenCipher('meeting-intelligence-tokens');
    return this.tokenCipherInstance;
  }

  private get stateCipher(): TokenCipher {
    this.stateCipherInstance ??= this.options.stateCipher ?? new TokenCipher('meeting-intelligence-oauth-state');
    return this.stateCipherInstance;
  }

  async getStatus(userId: string): Promise<MeetingIntelligenceStatus> {
    const row = await this.repo.findConnection(userId);
    return {
      connected: Boolean(row),
      externalName: row?.external_name ?? null,
      externalEmail: row?.external_email ?? null,
      connectedAt: row?.connected_at ?? null,
    };
  }

  /**
   * Start connecting: make sure this app has a client registered for
   * `redirectUri`, then build the authorization URL and the sealed state the
   * callback needs. Throws `MeetingIntelligenceOAuthError`
   * (`invalid_redirect_uri`) when the redirect domain isn't whitelisted.
   */
  async beginAuthorization(input: {
    userId: string;
    redirectUri: string;
    returnTo: string;
  }): Promise<{ authorizeUrl: string; sealedState: string }> {
    const clientId = await this.ensureClientId(input.redirectUri);
    const { codeVerifier, codeChallenge } = generatePkce();
    const state = generateState();
    const pending: PendingAuthorization = {
      userId: input.userId,
      state,
      codeVerifier,
      clientId,
      redirectUri: input.redirectUri,
      returnTo: input.returnTo,
      issuedAt: this.now(),
    };
    return {
      authorizeUrl: buildAuthorizeUrl(this.endpoints, {
        clientId,
        redirectUri: input.redirectUri,
        codeChallenge,
        state,
      }),
      sealedState: this.stateCipher.encrypt(JSON.stringify(pending)),
    };
  }

  /**
   * Open the sealed state from the connect step. Returns null when it is
   * missing, tampered with, or older than the server's 10-minute window — the
   * route then has nowhere trustworthy to send the member but Profile.
   */
  openPendingAuthorization(sealedState: string | undefined | null): PendingAuthorization | null {
    if (!sealedState) return null;
    try {
      const pending = JSON.parse(this.stateCipher.decrypt(sealedState)) as PendingAuthorization;
      if (typeof pending?.state !== 'string' || typeof pending.issuedAt !== 'number') return null;
      if (this.now() - pending.issuedAt > PENDING_AUTHORIZATION_TTL_MS) return null;
      return pending;
    } catch {
      return null;
    }
  }

  /**
   * Finish connecting: check the callback belongs to the member who started
   * it, exchange the code, learn who they are on the other side, and store the
   * encrypted tokens (replacing any earlier connection).
   */
  async completeAuthorization(input: {
    userId: string;
    pending: PendingAuthorization;
    state: string;
    code: string;
  }): Promise<MeetingIntelligenceStatus> {
    const { pending } = input;
    if (pending.userId !== input.userId) {
      throw new MeetingIntelligenceAuthorizationError('This sign-in was started by a different user');
    }
    if (pending.state !== input.state) {
      throw new MeetingIntelligenceAuthorizationError('The sign-in state did not match; please try again');
    }

    let tokens;
    try {
      tokens = await this.http.exchangeCode(this.endpoints, {
        clientId: pending.clientId,
        code: input.code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
      });
    } catch (err) {
      if (err instanceof MeetingIntelligenceOAuthError && err.code === 'invalid_client') {
        // Our registration was dropped server-side; the next connect re-registers.
        await this.repo.deleteClientId(this.endpoints.serverUrl, pending.redirectUri);
      }
      throw new MeetingIntelligenceAuthorizationError(
        err instanceof Error ? err.message : 'Token exchange failed',
      );
    }

    const identity = await this.whoami(tokens.accessToken);
    const row = await this.repo.upsertConnection({
      userId: input.userId,
      serverUrl: this.endpoints.serverUrl,
      clientId: pending.clientId,
      accessTokenEnc: this.tokenCipher.encrypt(tokens.accessToken),
      refreshTokenEnc: this.tokenCipher.encrypt(tokens.refreshToken),
      accessTokenExpiresAt: tokens.expiresAt.toISOString(),
      scope: tokens.scope,
      externalName: identity.name,
      externalEmail: identity.email,
    });
    return {
      connected: true,
      externalName: row.external_name,
      externalEmail: row.external_email,
      connectedAt: row.connected_at,
    };
  }

  /** Revoke the grant (best effort) and forget the member's tokens. */
  async disconnect(userId: string): Promise<void> {
    const row = await this.repo.findConnection(userId);
    if (!row) return;
    try {
      await this.http.revokeToken(this.endpointsFor(row), {
        clientId: row.client_id,
        token: this.tokenCipher.decrypt(row.refresh_token_enc),
      });
    } catch {
      // Undecryptable tokens can't be revoked; deleting them is all we can do.
    }
    await this.repo.deleteConnection(userId);
  }

  /**
   * Call one Meeting Intelligence tool as the member. Refreshes the access
   * token when it is about to expire, and once more on a 401. Throws
   * `MeetingIntelligenceNotConnectedError` when the member must (re)connect.
   */
  async callTool(userId: string, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return this.withAccessToken(userId, (endpoints, token) =>
      this.http.callMcpTool(endpoints, token, name, args),
    );
  }

  /** One tool's definition from `tools/list` (its input schema), or null. */
  async describeTool(userId: string, name: string): Promise<McpToolDefinition | null> {
    const tools = await this.withAccessToken(userId, (endpoints, token) =>
      this.http.listMcpTools(endpoints, token),
    );
    return tools.find((t) => t.name === name) ?? null;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async ensureClientId(redirectUri: string): Promise<string> {
    const existing = await this.repo.findClientId(this.endpoints.serverUrl, redirectUri);
    if (existing) return existing;
    const clientId = await this.http.registerClient(this.endpoints, redirectUri);
    await this.repo.saveClientId(this.endpoints.serverUrl, redirectUri, clientId);
    return clientId;
  }

  /** A connection made against another server URL keeps talking to that server. */
  private endpointsFor(row: MeetingIntelligenceConnectionRow): MeetingIntelligenceEndpoints {
    return row.server_url === this.endpoints.serverUrl
      ? this.endpoints
      : meetingIntelligenceEndpoints(row.server_url);
  }

  private async whoami(accessToken: string): Promise<{ name: string | null; email: string | null }> {
    try {
      const result = await this.http.callMcpTool(this.endpoints, accessToken, 'whoami', {});
      const data = (result.structuredContent ?? {}) as { name?: unknown; email?: unknown };
      return {
        name: typeof data.name === 'string' ? data.name : null,
        email: typeof data.email === 'string' ? data.email : null,
      };
    } catch {
      // Identity is a display nicety — never fail the connection over it.
      return { name: null, email: null };
    }
  }

  private async withAccessToken<T>(
    userId: string,
    fn: (endpoints: MeetingIntelligenceEndpoints, accessToken: string) => Promise<T>,
  ): Promise<T> {
    const row = await this.repo.findConnection(userId);
    if (!row) throw new MeetingIntelligenceNotConnectedError('not_connected');
    const endpoints = this.endpointsFor(row);

    let token: string;
    let staleEnc = row.access_token_enc;
    if (Date.parse(row.access_token_expires_at) - this.now() > REFRESH_SKEW_MS) {
      token = await this.decryptOrDisconnect(userId, row.access_token_enc);
    } else {
      ({ token, enc: staleEnc } = await this.refresh(userId, row.access_token_enc));
    }
    try {
      return await fn(endpoints, token);
    } catch (err) {
      if (!(err instanceof McpUnauthorizedError)) throw err;
    }
    // 401: the token was revoked or expired early. One refresh, one retry.
    const refreshed = await this.refresh(userId, staleEnc);
    try {
      return await fn(endpoints, refreshed.token);
    } catch (err) {
      if (err instanceof McpUnauthorizedError) {
        // Even a fresh token is refused: the member lost access.
        await this.repo.deleteConnection(userId);
        throw new MeetingIntelligenceNotConnectedError('expired');
      }
      throw err;
    }
  }

  private async decryptOrDisconnect(userId: string, enc: string): Promise<string> {
    try {
      return this.tokenCipher.decrypt(enc);
    } catch (err) {
      if (err instanceof TokenDecryptionError) {
        // AUTH_SECRET rotated, or a corrupt row: the tokens are unusable.
        await this.repo.deleteConnection(userId);
        throw new MeetingIntelligenceNotConnectedError('expired');
      }
      throw err;
    }
  }

  /**
   * Get a fresh access token, refreshing at most once across concurrent
   * requests. `staleEnc` is the access-token ciphertext the caller found
   * unusable: if the stored one differs by the time we look, another request
   * already refreshed and we reuse its token instead of rotating again.
   * Returns the token and the ciphertext it is stored as.
   */
  private async refresh(userId: string, staleEnc: string): Promise<{ token: string; enc: string }> {
    for (let attempt = 0; attempt < REFRESH_WAIT_ATTEMPTS; attempt++) {
      const claimed = await this.repo.claimRefreshLease(userId, REFRESH_LEASE_SECONDS);
      if (claimed) {
        const alreadyFresh =
          claimed.access_token_enc !== staleEnc &&
          Date.parse(claimed.access_token_expires_at) - this.now() > REFRESH_SKEW_MS;
        if (alreadyFresh) {
          await this.repo.releaseRefreshLease(userId);
          const token = await this.decryptOrDisconnect(userId, claimed.access_token_enc);
          return { token, enc: claimed.access_token_enc };
        }
        return this.refreshWithLease(userId, claimed);
      }

      const row = await this.repo.findConnection(userId);
      if (!row) throw new MeetingIntelligenceNotConnectedError('expired');
      if (row.access_token_enc !== staleEnc) {
        // Someone else refreshed while we waited.
        const token = await this.decryptOrDisconnect(userId, row.access_token_enc);
        return { token, enc: row.access_token_enc };
      }
      await this.sleep(REFRESH_WAIT_MS);
    }
    throw new MeetingIntelligenceRefreshPendingError();
  }

  private async refreshWithLease(
    userId: string,
    row: MeetingIntelligenceConnectionRow,
  ): Promise<{ token: string; enc: string }> {
    const refreshToken = await this.decryptOrDisconnect(userId, row.refresh_token_enc);
    let tokens;
    try {
      tokens = await this.http.refreshTokens(this.endpointsFor(row), {
        clientId: row.client_id,
        refreshToken,
      });
    } catch (err) {
      if (
        err instanceof MeetingIntelligenceOAuthError &&
        (err.code === 'invalid_grant' || err.code === 'invalid_client')
      ) {
        await this.repo.deleteConnection(userId);
        throw new MeetingIntelligenceNotConnectedError('expired');
      }
      await this.repo.releaseRefreshLease(userId);
      throw err;
    }
    const enc = this.tokenCipher.encrypt(tokens.accessToken);
    await this.repo.saveRefreshedTokens(userId, {
      accessTokenEnc: enc,
      refreshTokenEnc: this.tokenCipher.encrypt(tokens.refreshToken),
      accessTokenExpiresAt: tokens.expiresAt.toISOString(),
      scope: tokens.scope,
    });
    return { token: tokens.accessToken, enc };
  }
}
