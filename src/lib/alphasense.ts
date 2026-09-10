/**
 * AlphaSense Agent API client.
 *
 * Wraps the two calls the Agent API needs (https://developer.alpha-sense.com/agent-api/quickstart):
 *
 *  1. `POST /auth` — OAuth2 password grant that exchanges the API key + client
 *     credentials + user credentials for a bearer `access_token`.
 *  2. `POST /gql` — the GraphQL endpoint used to (a) start a GenSearch run via
 *     the `genSearch.auto` mutation and (b) poll `genSearch.conversation` until
 *     `progress` reaches 1.0, at which point `markdown` holds the cited answer.
 *
 * GenSearch is asynchronous and can take a minute or more, so `runGenSearch`
 * polls with a bounded deadline and returns whatever it has (flagged
 * `timedOut`) rather than hanging a caller forever.
 *
 * Access tokens are cached in-module keyed by api key + username so a chat
 * turn that fires several AlphaSense calls only authenticates once.
 */

export const ALPHASENSE_AUTH_URL = "https://api.alpha-sense.com/auth";
export const ALPHASENSE_GRAPHQL_URL = "https://api.alpha-sense.com/gql";

/** Env vars that must all be set for the integration to be usable. */
export const ALPHASENSE_ENV_VARS = [
  "ALPHASENSE_API_KEY",
  "ALPHASENSE_CLIENT_ID",
  "ALPHASENSE_CLIENT_SECRET",
  "ALPHASENSE_EMAIL",
  "ALPHASENSE_PASSWORD",
] as const;

export interface AlphaSenseCredentials {
  apiKey: string;
  clientId: string;
  clientSecret: string;
  email: string;
  password: string;
}

export class AlphaSenseError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AlphaSenseError";
  }
}

export interface AlphaSenseCredentialsResult {
  credentials: AlphaSenseCredentials | null;
  /** Names of the env vars that are unset/blank. Empty when `credentials` is non-null. */
  missing: string[];
}

/**
 * Read the AlphaSense credentials out of the environment. Returns the missing
 * variable names instead of throwing so callers (agent tools) can degrade to a
 * readable "not configured" message.
 */
export function readAlphaSenseCredentials(
  env: NodeJS.ProcessEnv = process.env,
): AlphaSenseCredentialsResult {
  const missing = ALPHASENSE_ENV_VARS.filter((name) => !env[name]?.trim());
  if (missing.length > 0) return { credentials: null, missing: [...missing] };

  return {
    credentials: {
      apiKey: env.ALPHASENSE_API_KEY!.trim(),
      clientId: env.ALPHASENSE_CLIENT_ID!.trim(),
      clientSecret: env.ALPHASENSE_CLIENT_SECRET!.trim(),
      email: env.ALPHASENSE_EMAIL!.trim(),
      // Deliberately NOT trimmed: a password may legitimately end in
      // whitespace, and silently altering it would surface as a confusing 401.
      // The blank check above already rejects a whitespace-only value.
      password: env.ALPHASENSE_PASSWORD!,
    },
    missing: [],
  };
}

interface CachedToken {
  token: string;
  /** Epoch ms after which the token must be re-fetched. */
  expiresAt: number;
}

const tokenCache = new Map<string, CachedToken>();

/** Test seam / credential-rotation escape hatch. */
export function clearAlphaSenseTokenCache(): void {
  tokenCache.clear();
}

/** Fallback token lifetime when the auth response omits `expires_in`. */
const DEFAULT_TOKEN_TTL_SECONDS = 1800;
/** Refresh this many seconds before the real expiry to avoid edge-of-expiry 401s. */
const TOKEN_EXPIRY_SKEW_SECONDS = 60;

export const GEN_SEARCH_MUTATION = `
mutation GenSearch($input: GenSearchInput!) {
  genSearch {
    auto(input: $input) {
      id
    }
  }
}
`;

export const GEN_SEARCH_POLL_QUERY = `
query Query($conversationId: String!) {
  genSearch {
    conversation(id: $conversationId) {
      id
      markdown
      progress
      error {
        code
      }
    }
  }
}
`;

export interface AlphaSenseConversation {
  id: string;
  markdown: string | null;
  progress: number;
  error: { code: string } | null;
}

export interface AlphaSenseAnswer {
  conversationId: string;
  markdown: string;
  progress: number;
  /** True when the poll deadline elapsed before progress reached 1.0. */
  timedOut: boolean;
}

export interface RunGenSearchOptions {
  /** Delay between polls (default 2000ms, per AlphaSense's quickstart). */
  pollIntervalMs?: number;
  /** Overall budget for the polling loop (default 180s). */
  timeoutMs?: number;
}

export interface AlphaSenseClientOptions {
  credentials: AlphaSenseCredentials;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class AlphaSenseClient {
  private readonly credentials: AlphaSenseCredentials;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor({ credentials, fetchImpl, sleep, now }: AlphaSenseClientOptions) {
    this.credentials = credentials;
    this.fetchImpl = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.sleep = sleep ?? defaultSleep;
    this.now = now ?? (() => Date.now());
  }

  private get cacheKey(): string {
    return `${this.credentials.apiKey}::${this.credentials.email}`;
  }

  /**
   * Return a bearer token, reusing the cached one until it is close to expiry.
   * Pass `force` to bypass the cache (used once on a 401 retry).
   */
  async getAccessToken(force = false): Promise<string> {
    const cached = tokenCache.get(this.cacheKey);
    if (!force && cached && cached.expiresAt > this.now()) return cached.token;

    const { apiKey, clientId, clientSecret, email, password } = this.credentials;
    const response = await this.fetchImpl(ALPHASENSE_AUTH_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "password",
        username: email,
        password,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });

    if (!response.ok) {
      const body = await safeText(response);
      throw new AlphaSenseError(
        `AlphaSense auth failed: ${response.status} ${body}`.trim(),
        "AUTH_FAILED",
        response.status,
      );
    }

    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload?.access_token) {
      throw new AlphaSenseError("AlphaSense auth response did not include an access_token", "AUTH_FAILED");
    }

    const ttlSeconds = typeof payload.expires_in === "number" && payload.expires_in > 0
      ? payload.expires_in
      : DEFAULT_TOKEN_TTL_SECONDS;
    // Never cache past the real TTL. When expires_in is shorter than the skew,
    // expiresAt is now (or in the past) so the next call re-authenticates.
    const lifetimeMs = Math.max(ttlSeconds - TOKEN_EXPIRY_SKEW_SECONDS, 0) * 1000;

    tokenCache.set(this.cacheKey, { token: payload.access_token, expiresAt: this.now() + lifetimeMs });
    return payload.access_token;
  }

  /**
   * Execute a GraphQL operation. Re-authenticates once on a 401/403 so a
   * stale cached token doesn't surface as a user-visible failure.
   */
  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let token = await this.getAccessToken();
    let response = await this.postGql(query, variables, token);

    if (response.status === 401 || response.status === 403) {
      token = await this.getAccessToken(true);
      response = await this.postGql(query, variables, token);
    }

    if (!response.ok) {
      const body = await safeText(response);
      throw new AlphaSenseError(
        `AlphaSense API error: ${response.status} ${body}`.trim(),
        "HTTP_ERROR",
        response.status,
      );
    }

    const payload = (await response.json()) as { data?: T; errors?: { message?: string }[] };
    if (payload?.errors?.length) {
      const message = payload.errors.map((e) => e?.message ?? "unknown error").join("; ");
      throw new AlphaSenseError(`AlphaSense GraphQL error: ${message}`, "GRAPHQL_ERROR");
    }
    if (!payload?.data) {
      throw new AlphaSenseError("AlphaSense GraphQL response contained no data", "GRAPHQL_ERROR");
    }
    return payload.data;
  }

  private postGql(query: string, variables: Record<string, unknown>, token: string) {
    return this.fetchImpl(ALPHASENSE_GRAPHQL_URL, {
      method: "POST",
      headers: {
        "x-api-key": this.credentials.apiKey,
        clientid: this.credentials.clientId,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
  }

  /** Kick off a GenSearch run and return its conversation id. */
  async startGenSearch(prompt: string): Promise<string> {
    const data = await this.gql<{ genSearch?: { auto?: { id?: string } } }>(GEN_SEARCH_MUTATION, {
      input: { prompt },
    });
    const id = data.genSearch?.auto?.id;
    if (!id) {
      throw new AlphaSenseError("AlphaSense GenSearch did not return a conversation id", "NO_CONVERSATION_ID");
    }
    return id;
  }

  /** Read the current state of a GenSearch conversation. */
  async getConversation(conversationId: string): Promise<AlphaSenseConversation> {
    const data = await this.gql<{ genSearch?: { conversation?: Partial<AlphaSenseConversation> } }>(
      GEN_SEARCH_POLL_QUERY,
      { conversationId },
    );
    const conversation = data.genSearch?.conversation;
    if (!conversation) {
      throw new AlphaSenseError(`AlphaSense conversation ${conversationId} was not found`, "CONVERSATION_NOT_FOUND");
    }
    return {
      id: conversation.id ?? conversationId,
      markdown: conversation.markdown ?? null,
      progress: typeof conversation.progress === "number" ? conversation.progress : 0,
      error: conversation.error ?? null,
    };
  }

  /**
   * Run a GenSearch prompt end to end: start the conversation, then poll until
   * it completes, errors, or the deadline passes.
   */
  async runGenSearch(prompt: string, options: RunGenSearchOptions = {}): Promise<AlphaSenseAnswer> {
    const pollIntervalMs = options.pollIntervalMs ?? 2000;
    const timeoutMs = options.timeoutMs ?? 180_000;
    const deadline = this.now() + timeoutMs;

    const conversationId = await this.startGenSearch(prompt);

    let conversation = await this.getConversation(conversationId);
    while (true) {
      if (conversation.error) {
        throw new AlphaSenseError(
          `AlphaSense GenSearch failed: ${conversation.error.code}`,
          conversation.error.code,
        );
      }
      if (conversation.progress >= 1) {
        return {
          conversationId,
          markdown: conversation.markdown ?? "",
          progress: conversation.progress,
          timedOut: false,
        };
      }
      const remainingMs = deadline - this.now();
      if (remainingMs <= 0) {
        return {
          conversationId,
          markdown: conversation.markdown ?? "",
          progress: conversation.progress,
          timedOut: true,
        };
      }
      await this.sleep(Math.min(pollIntervalMs, remainingMs));
      conversation = await this.getConversation(conversationId);
    }
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "";
  }
}
