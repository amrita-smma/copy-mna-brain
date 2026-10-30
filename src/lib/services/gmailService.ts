import type { GmailConnectionRow, GmailRepository } from '@/lib/repositories/gmailRepository';
import { TokenCipher, TokenDecryptionError } from '@/lib/crypto/tokenCipher';
import {
  buildAuthorizeUrl,
  exchangeCode,
  getMessage,
  getProfile,
  getThread,
  generatePkce,
  generateState,
  GMAIL_COMPOSE_SCOPE,
  GMAIL_SCOPE,
  gmailCredentials,
  hasGmailScope,
  GmailOAuthError,
  GmailUnauthorizedError,
  refreshAccessToken,
  revokeToken,
  searchMessages,
  buildDraftMime,
  createDraft,
  toBase64Url,
  type DraftAttachment,
  type GmailCredentials,
  type GmailDraft,
  type GmailMessage,
  type GmailMessageSummary,
} from '@/lib/gmail';

/** Refresh when the access token has less than this left. */
const REFRESH_SKEW_MS = 60_000;
/** The member gets 10 minutes to finish signing in. */
const PENDING_AUTHORIZATION_TTL_MS = 10 * 60_000;

/** This deployment has no Google OAuth client secret (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`). */
export class GmailNotConfiguredError extends Error {
  constructor() {
    super('Gmail is not configured: GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not both set');
    this.name = 'GmailNotConfiguredError';
  }
}

/**
 * The member has no usable connection: never connected, disconnected, or the
 * grant expired / was revoked (removed from their Google account, or Google
 * expiring a "Testing" app's refresh token after 7 days). The fix is always the
 * same: connect again from Profile.
 */
export class GmailNotConnectedError extends Error {
  constructor(readonly reason: 'not_connected' | 'expired') {
    super(reason === 'expired' ? 'The Gmail connection has expired or was revoked' : 'Gmail is not connected');
    this.name = 'GmailNotConnectedError';
  }
}

/**
 * The connection exists but the member didn't grant the permission this needs
 * (older connections predate draft access; the consent screen also lets a
 * member untick it). Connecting again, with the box ticked, fixes it.
 */
export class GmailScopeMissingError extends Error {
  constructor(readonly scope: string) {
    super(`The Gmail connection does not include the ${scope} permission`);
    this.name = 'GmailScopeMissingError';
  }
}

/** The OAuth callback could not be completed (bad/expired state, failed exchange, missing scope). */
export class GmailAuthorizationError extends Error {
  constructor(
    message: string,
    readonly reason: string = 'authorization_failed',
  ) {
    super(message);
    this.name = 'GmailAuthorizationError';
  }
}

export interface GmailStatus {
  connected: boolean;
  googleEmail: string | null;
  connectedAt: string | null;
  /** The connection includes `gmail.compose`, so bots can save drafts (older connections don't). */
  canDraft: boolean;
}

/** A draft to save in the member's mailbox. Recipients are plain addresses. */
export interface GmailDraftInput {
  to: string[];
  subject: string;
  text: string;
  html: string;
  attachments?: DraftAttachment[];
}

export interface GmailDraftResult extends GmailDraft {
  /** The mailbox the draft is in, when known. */
  googleEmail: string | null;
}

/**
 * What must survive the browser round-trip to Google. Sealed (encrypted) into
 * an httpOnly cookie by the connect route and opened by the callback — the
 * PKCE verifier never reaches the browser in the clear.
 */
export interface PendingGmailAuthorization {
  userId: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  /** In-app path to land on afterwards (validated by the route). */
  returnTo: string;
  issuedAt: number;
}

/** The HTTP calls the service makes — injectable for tests. */
export interface GmailHttp {
  exchangeCode: typeof exchangeCode;
  refreshAccessToken: typeof refreshAccessToken;
  revokeToken: typeof revokeToken;
  getProfile: typeof getProfile;
  searchMessages: typeof searchMessages;
  getMessage: typeof getMessage;
  getThread: typeof getThread;
  createDraft: typeof createDraft;
}

const defaultHttp: GmailHttp = {
  exchangeCode,
  refreshAccessToken,
  revokeToken,
  getProfile,
  searchMessages,
  getMessage,
  getThread,
  createDraft,
};

export interface GmailServiceOptions {
  /** `null` = not configured. Defaults to the `GOOGLE_CLIENT_*` env vars, read per call. */
  credentials?: GmailCredentials | null;
  http?: GmailHttp;
  tokenCipher?: TokenCipher;
  stateCipher?: TokenCipher;
  now?: () => number;
}

/**
 * The Gmail integration: connecting a member's Google account over OAuth,
 * keeping their access token fresh, reading their mail as them (read-only) and
 * saving drafts in their Drafts folder — never sending. See docs/features/gmail.md.
 *
 * Google's refresh tokens are long-lived and do not rotate, so — unlike the
 * Meeting Intelligence integration — there is no refresh lease: two requests
 * refreshing at once both succeed. A refresh failing with `invalid_grant`
 * means the grant is gone: the row is deleted and the member must connect
 * again. Tokens are stored encrypted and never logged.
 */
export class GmailService {
  private readonly http: GmailHttp;
  private readonly options: GmailServiceOptions;
  private readonly now: () => number;
  private tokenCipherInstance: TokenCipher | undefined;
  private stateCipherInstance: TokenCipher | undefined;

  constructor(
    private readonly repo: GmailRepository,
    options: GmailServiceOptions = {},
  ) {
    this.options = options;
    this.http = options.http ?? defaultHttp;
    this.now = options.now ?? Date.now;
  }

  // Built on first use so constructing the container never needs AUTH_SECRET.
  private get tokenCipher(): TokenCipher {
    this.tokenCipherInstance ??= this.options.tokenCipher ?? new TokenCipher('gmail-tokens');
    return this.tokenCipherInstance;
  }

  private get stateCipher(): TokenCipher {
    this.stateCipherInstance ??= this.options.stateCipher ?? new TokenCipher('gmail-oauth-state');
    return this.stateCipherInstance;
  }

  private get credentials(): GmailCredentials | null {
    return this.options.credentials !== undefined ? this.options.credentials : gmailCredentials();
  }

  /** Whether this deployment has a Google OAuth client for Gmail. */
  isConfigured(): boolean {
    return this.credentials !== null;
  }

  private requireCredentials(): GmailCredentials {
    const credentials = this.credentials;
    if (!credentials) throw new GmailNotConfiguredError();
    return credentials;
  }

  async getStatus(userId: string): Promise<GmailStatus> {
    const row = await this.repo.findConnection(userId);
    return {
      connected: Boolean(row),
      googleEmail: row?.google_email ?? null,
      connectedAt: row?.connected_at ?? null,
      canDraft: row ? hasGmailScope(row.scope, GMAIL_COMPOSE_SCOPE) : false,
    };
  }

  /**
   * Start connecting: build Google's authorization URL and the sealed state the
   * callback needs. Throws `GmailNotConfiguredError` without a Google client.
   */
  beginAuthorization(input: {
    userId: string;
    redirectUri: string;
    returnTo: string;
  }): { authorizeUrl: string; sealedState: string } {
    const credentials = this.requireCredentials();
    const { codeVerifier, codeChallenge } = generatePkce();
    const state = generateState();
    const pending: PendingGmailAuthorization = {
      userId: input.userId,
      state,
      codeVerifier,
      redirectUri: input.redirectUri,
      returnTo: input.returnTo,
      issuedAt: this.now(),
    };
    return {
      authorizeUrl: buildAuthorizeUrl(credentials, { redirectUri: input.redirectUri, codeChallenge, state }),
      sealedState: this.stateCipher.encrypt(JSON.stringify(pending)),
    };
  }

  /**
   * Open the sealed state from the connect step. Returns null when it is
   * missing, tampered with, or older than 10 minutes — the route then has
   * nowhere trustworthy to send the member but the default page.
   */
  openPendingAuthorization(sealedState: string | undefined | null): PendingGmailAuthorization | null {
    if (!sealedState) return null;
    try {
      const pending = JSON.parse(this.stateCipher.decrypt(sealedState)) as PendingGmailAuthorization;
      if (
        typeof pending?.state !== 'string' ||
        typeof pending.issuedAt !== 'number' ||
        typeof pending.userId !== 'string' ||
        typeof pending.codeVerifier !== 'string' ||
        typeof pending.redirectUri !== 'string' ||
        typeof pending.returnTo !== 'string'
      ) {
        return null;
      }
      if (this.now() - pending.issuedAt > PENDING_AUTHORIZATION_TTL_MS) return null;
      return pending;
    } catch {
      return null;
    }
  }

  /**
   * Finish connecting: check the callback belongs to the member who started
   * it, exchange the code, check Google granted the Gmail scope, learn which
   * mailbox it is, and store the encrypted tokens (replacing any earlier
   * connection).
   *
   * Google's consent screen lets a member untick individual permissions, so a
   * successful exchange can still lack `gmail.readonly` (`missing_scope`).
   */
  async completeAuthorization(input: {
    userId: string;
    pending: PendingGmailAuthorization;
    state: string;
    code: string;
  }): Promise<GmailStatus> {
    const { pending } = input;
    if (pending.userId !== input.userId) {
      throw new GmailAuthorizationError('This sign-in was started by a different user');
    }
    if (pending.state !== input.state) {
      throw new GmailAuthorizationError('The sign-in state did not match; please try again');
    }

    let tokens;
    try {
      tokens = await this.http.exchangeCode(this.requireCredentials(), {
        code: input.code,
        codeVerifier: pending.codeVerifier,
        redirectUri: pending.redirectUri,
      });
    } catch (err) {
      if (err instanceof GmailNotConfiguredError) throw err;
      throw new GmailAuthorizationError(err instanceof Error ? err.message : 'Token exchange failed');
    }

    if (!tokens.scope?.split(' ').includes(GMAIL_SCOPE)) {
      // Nothing is stored; the member can connect again and leave the box ticked.
      await this.http.revokeToken({ token: tokens.refreshToken ?? tokens.accessToken });
      throw new GmailAuthorizationError('Google did not grant permission to read Gmail', 'missing_scope');
    }
    if (!tokens.refreshToken) {
      // `prompt=consent` makes Google send one; without it the connection would die within the hour.
      await this.http.revokeToken({ token: tokens.accessToken });
      throw new GmailAuthorizationError('Google did not return a refresh token', 'no_refresh_token');
    }

    const row = await this.repo.upsertConnection({
      userId: input.userId,
      accessTokenEnc: this.tokenCipher.encrypt(tokens.accessToken),
      refreshTokenEnc: this.tokenCipher.encrypt(tokens.refreshToken),
      accessTokenExpiresAt: tokens.expiresAt.toISOString(),
      scope: tokens.scope,
      googleEmail: await this.mailboxAddress(tokens.accessToken),
    });
    return {
      connected: true,
      googleEmail: row.google_email,
      connectedAt: row.connected_at,
      canDraft: hasGmailScope(tokens.scope, GMAIL_COMPOSE_SCOPE),
    };
  }

  /** Revoke the grant (best effort) and forget the member's tokens. */
  async disconnect(userId: string): Promise<void> {
    const row = await this.repo.findConnection(userId);
    if (!row) return;
    try {
      await this.http.revokeToken({ token: this.tokenCipher.decrypt(row.refresh_token_enc) });
    } catch {
      // Undecryptable tokens can't be revoked; deleting them is all we can do.
    }
    await this.repo.deleteConnection(userId);
  }

  /**
   * Search the member's mailbox with Gmail query syntax, newest first. Throws
   * `GmailNotConnectedError` when the member must (re)connect.
   */
  search(
    userId: string,
    input: { query: string; maxResults?: number },
  ): Promise<{ messages: GmailMessageSummary[]; hasMore: boolean }> {
    return this.withAccessToken(userId, (token) => this.http.searchMessages(token, input));
  }

  readMessage(userId: string, messageId: string): Promise<GmailMessage> {
    return this.withAccessToken(userId, (token) => this.http.getMessage(token, messageId));
  }

  readThread(userId: string, threadId: string): Promise<{ messages: GmailMessage[]; totalMessages: number }> {
    return this.withAccessToken(userId, (token) => this.http.getThread(token, threadId));
  }

  /**
   * Save a draft in the member's Gmail Drafts folder. Nothing is sent: the
   * member reviews it in Gmail and presses Send themselves. Throws
   * `GmailNotConnectedError` when they must (re)connect, and
   * `GmailScopeMissingError` when their connection predates (or declined)
   * draft access.
   */
  async createDraft(userId: string, input: GmailDraftInput): Promise<GmailDraftResult> {
    // Built before touching the token, so a bad recipient fails without a Google call.
    const raw = toBase64Url(buildDraftMime(input));
    return this.withAccessToken(
      userId,
      async (token, row) => ({ ...(await this.http.createDraft(token, raw)), googleEmail: row.google_email }),
      GMAIL_COMPOSE_SCOPE,
    );
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async mailboxAddress(accessToken: string): Promise<string | null> {
    try {
      return (await this.http.getProfile(accessToken)).emailAddress;
    } catch {
      // The address is a display nicety — never fail the connection over it.
      return null;
    }
  }

  private async withAccessToken<T>(
    userId: string,
    fn: (accessToken: string, row: GmailConnectionRow) => Promise<T>,
    requiredScope?: string,
  ): Promise<T> {
    const row = await this.repo.findConnection(userId);
    if (!row) throw new GmailNotConnectedError('not_connected');
    if (requiredScope && !hasGmailScope(row.scope, requiredScope)) throw new GmailScopeMissingError(requiredScope);

    const token =
      Date.parse(row.access_token_expires_at) - this.now() > REFRESH_SKEW_MS
        ? await this.decryptOrDisconnect(userId, row.access_token_enc)
        : await this.refresh(userId, row);
    try {
      return await fn(token, row);
    } catch (err) {
      if (!(err instanceof GmailUnauthorizedError)) throw err;
    }
    // 401: the token was revoked or expired early. One refresh, one retry.
    const refreshed = await this.refresh(userId, row);
    try {
      return await fn(refreshed, row);
    } catch (err) {
      if (err instanceof GmailUnauthorizedError) {
        // Even a fresh token is refused: the member lost access.
        await this.repo.deleteConnection(userId);
        throw new GmailNotConnectedError('expired');
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
        throw new GmailNotConnectedError('expired');
      }
      throw err;
    }
  }

  /** Trade the refresh token for a new access token and store it. Returns the new access token. */
  private async refresh(userId: string, row: GmailConnectionRow): Promise<string> {
    const credentials = this.requireCredentials();
    const refreshToken = await this.decryptOrDisconnect(userId, row.refresh_token_enc);
    let tokens;
    try {
      tokens = await this.http.refreshAccessToken(credentials, { refreshToken });
    } catch (err) {
      // Only `invalid_grant` means the member's grant is gone. `invalid_client`
      // is OUR credentials being wrong — deleting their connection over a bad
      // deploy config would make them reconnect for nothing, so it propagates.
      if (err instanceof GmailOAuthError && err.code === 'invalid_grant') {
        await this.repo.deleteConnection(userId);
        throw new GmailNotConnectedError('expired');
      }
      throw err;
    }
    await this.repo.saveRefreshedTokens(userId, {
      accessTokenEnc: this.tokenCipher.encrypt(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken ? this.tokenCipher.encrypt(tokens.refreshToken) : undefined,
      accessTokenExpiresAt: tokens.expiresAt.toISOString(),
    });
    return tokens.accessToken;
  }
}
