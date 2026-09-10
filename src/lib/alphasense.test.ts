import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ALPHASENSE_AUTH_URL,
  ALPHASENSE_GRAPHQL_URL,
  AlphaSenseClient,
  AlphaSenseError,
  clearAlphaSenseTokenCache,
  readAlphaSenseCredentials,
} from './alphasense';

const CREDENTIALS = {
  apiKey: 'key-1',
  clientId: 'client-1',
  clientSecret: 'secret-1',
  email: 'analyst@example.com',
  password: 'pw',
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function textResponse(body: string, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error('not json');
    },
    text: async () => body,
  } as unknown as Response;
}

const authOk = () => jsonResponse({ access_token: 'token-1', expires_in: 3600 });
const startOk = (id = 'conv-1') => jsonResponse({ data: { genSearch: { auto: { id } } } });
const pollOk = (progress: number, markdown: string | null = null, error: { code: string } | null = null) =>
  jsonResponse({ data: { genSearch: { conversation: { id: 'conv-1', markdown, progress, error } } } });

function makeClient(fetchImpl: ReturnType<typeof vi.fn>, now = () => 0) {
  return new AlphaSenseClient({
    credentials: CREDENTIALS,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    sleep: async () => {},
    now,
  });
}

beforeEach(() => {
  clearAlphaSenseTokenCache();
  vi.clearAllMocks();
});

describe('readAlphaSenseCredentials', () => {
  it('returns credentials when every env var is set', () => {
    const { credentials, missing } = readAlphaSenseCredentials({
      ALPHASENSE_API_KEY: ' key-1 ',
      ALPHASENSE_CLIENT_ID: 'client-1',
      ALPHASENSE_CLIENT_SECRET: 'secret-1',
      ALPHASENSE_EMAIL: 'analyst@example.com',
      ALPHASENSE_PASSWORD: 'pw',
    } as unknown as NodeJS.ProcessEnv);

    expect(missing).toEqual([]);
    expect(credentials).toEqual(CREDENTIALS);
  });

  it('preserves the password verbatim while trimming the other values', () => {
    const { credentials } = readAlphaSenseCredentials({
      ALPHASENSE_API_KEY: ' key-1 ',
      ALPHASENSE_CLIENT_ID: 'client-1',
      ALPHASENSE_CLIENT_SECRET: 'secret-1',
      ALPHASENSE_EMAIL: 'analyst@example.com',
      ALPHASENSE_PASSWORD: ' pw ',
    } as unknown as NodeJS.ProcessEnv);

    expect(credentials?.apiKey).toBe('key-1');
    expect(credentials?.password).toBe(' pw ');
  });

  it('reports the names of every unset or blank variable', () => {
    const { credentials, missing } = readAlphaSenseCredentials({
      ALPHASENSE_API_KEY: 'key-1',
      ALPHASENSE_CLIENT_ID: '   ',
    } as unknown as NodeJS.ProcessEnv);

    expect(credentials).toBeNull();
    expect(missing).toEqual([
      'ALPHASENSE_CLIENT_ID',
      'ALPHASENSE_CLIENT_SECRET',
      'ALPHASENSE_EMAIL',
      'ALPHASENSE_PASSWORD',
    ]);
  });
});

describe('AlphaSenseClient.getAccessToken', () => {
  it('posts the password grant to the auth endpoint and returns the token', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(authOk());

    const token = await makeClient(fetchImpl).getAccessToken();

    expect(token).toBe('token-1');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(ALPHASENSE_AUTH_URL);
    expect(init.headers['x-api-key']).toBe('key-1');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const body = init.body as URLSearchParams;
    expect(Object.fromEntries(body.entries())).toEqual({
      grant_type: 'password',
      username: 'analyst@example.com',
      password: 'pw',
      client_id: 'client-1',
      client_secret: 'secret-1',
    });
  });

  it('reuses a cached token across clients until it nears expiry', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(authOk());
    let clock = 0;
    const client = makeClient(fetchImpl, () => clock);

    await client.getAccessToken();
    await client.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // expires_in 3600 minus the 60s skew → cached until 3_540_000ms.
    clock = 3_540_001;
    await client.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('re-authenticates immediately when expires_in is shorter than the skew', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ access_token: 'token-1', expires_in: 40 }));
    const client = makeClient(fetchImpl, () => 0);

    await client.getAccessToken();
    await client.getAccessToken();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws an AlphaSenseError when auth fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(textResponse('bad creds', 401));

    await expect(makeClient(fetchImpl).getAccessToken()).rejects.toThrow(/AlphaSense auth failed: 401 bad creds/);
  });

  it('throws when the auth response omits access_token', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse({}));

    await expect(makeClient(fetchImpl).getAccessToken()).rejects.toBeInstanceOf(AlphaSenseError);
  });
});

describe('AlphaSenseClient.startGenSearch', () => {
  it('sends the prompt as GenSearchInput and returns the conversation id', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(authOk()).mockResolvedValueOnce(startOk('conv-9'));

    const id = await makeClient(fetchImpl).startGenSearch('Apple Q4 2024 results');

    expect(id).toBe('conv-9');
    const [url, init] = fetchImpl.mock.calls[1];
    expect(url).toBe(ALPHASENSE_GRAPHQL_URL);
    expect(init.headers).toMatchObject({
      'x-api-key': 'key-1',
      clientid: 'client-1',
      Authorization: 'Bearer token-1',
      'Content-Type': 'application/json',
    });
    const payload = JSON.parse(init.body as string);
    expect(payload.query).toContain('mutation GenSearch');
    expect(payload.variables).toEqual({ input: { prompt: 'Apple Q4 2024 results' } });
  });

  it('surfaces GraphQL errors returned in the payload', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(authOk())
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: 'quota exceeded' }] }));

    await expect(makeClient(fetchImpl).startGenSearch('x')).rejects.toThrow(/quota exceeded/);
  });

  it('throws when the mutation returns no conversation id', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(authOk())
      .mockResolvedValueOnce(jsonResponse({ data: { genSearch: { auto: {} } } }));

    await expect(makeClient(fetchImpl).startGenSearch('x')).rejects.toThrow(/conversation id/);
  });

  it('re-authenticates once and retries when the API returns 401', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(authOk())
      .mockResolvedValueOnce(textResponse('expired', 401))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'token-2', expires_in: 3600 }))
      .mockResolvedValueOnce(startOk('conv-2'));

    const id = await makeClient(fetchImpl).startGenSearch('x');

    expect(id).toBe('conv-2');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls[3][1].headers.Authorization).toBe('Bearer token-2');
  });
});

describe('AlphaSenseClient.runGenSearch', () => {
  it('polls until progress reaches 1.0 and returns the markdown answer', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(authOk())
      .mockResolvedValueOnce(startOk())
      .mockResolvedValueOnce(pollOk(0.2))
      .mockResolvedValueOnce(pollOk(0.7))
      .mockResolvedValueOnce(pollOk(1, '## Answer\nRevenue grew 6%.'));

    const answer = await makeClient(fetchImpl).runGenSearch('q', { pollIntervalMs: 0 });

    expect(answer).toEqual({
      conversationId: 'conv-1',
      markdown: '## Answer\nRevenue grew 6%.',
      progress: 1,
      timedOut: false,
    });
  });

  it('throws with the AlphaSense error code when the conversation fails', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(authOk())
      .mockResolvedValueOnce(startOk())
      .mockResolvedValueOnce(pollOk(0.4, null, { code: 'INTERNAL_ERROR' }));

    await expect(makeClient(fetchImpl).runGenSearch('q', { pollIntervalMs: 0 })).rejects.toThrow(
      /GenSearch failed: INTERNAL_ERROR/,
    );
  });

  it('returns the partial answer flagged timedOut once the deadline passes', async () => {
    let clock = 0;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(authOk())
      .mockResolvedValueOnce(startOk())
      .mockResolvedValueOnce(pollOk(0.3, 'partial'));

    const client = new AlphaSenseClient({
      credentials: CREDENTIALS,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
      now: () => clock,
    });

    const promise = client.runGenSearch('q', { pollIntervalMs: 0, timeoutMs: 1000 });
    clock = 5000;
    const answer = await promise;

    expect(answer).toEqual({
      conversationId: 'conv-1',
      markdown: 'partial',
      progress: 0.3,
      timedOut: true,
    });
  });

  it('throws when the polled conversation is missing', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(authOk())
      .mockResolvedValueOnce(startOk())
      .mockResolvedValueOnce(jsonResponse({ data: { genSearch: {} } }));

    await expect(makeClient(fetchImpl).runGenSearch('q', { pollIntervalMs: 0 })).rejects.toThrow(/was not found/);
  });
});
