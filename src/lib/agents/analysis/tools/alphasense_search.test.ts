import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  runGenSearch: vi.fn(),
  readAlphaSenseCredentials: vi.fn(),
  recordCall: vi.fn(),
  getActiveWorkspaceId: vi.fn(async () => 'workspace-1'),
  createDb: vi.fn(() => ({})),
}));

vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/lib/alphasense', async () => {
  const actual = await vi.importActual<typeof import('@/lib/alphasense')>('@/lib/alphasense');
  return {
    ...actual,
    readAlphaSenseCredentials: mocks.readAlphaSenseCredentials,
    AlphaSenseClient: class {
      runGenSearch = mocks.runGenSearch;
    },
  };
});

vi.mock('@/lib/server/db', () => ({ createDb: mocks.createDb }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: mocks.getActiveWorkspaceId }));
vi.mock('@/lib/services', () => ({
  createContainer: vi.fn(() => ({ alphasenseToolCallService: { recordCall: mocks.recordCall } })),
}));

import { alphasenseSearch } from './alphasense_search';

const CREDENTIALS = {
  apiKey: 'key-1',
  clientId: 'client-1',
  clientSecret: 'secret-1',
  email: 'analyst@example.com',
  password: 'pw',
};

function call(args: { prompt: string }, config?: { configurable?: Record<string, unknown> }) {
  return alphasenseSearch.invoke(args as never, config as never);
}

beforeEach(() => {
  mocks.runGenSearch.mockReset();
  mocks.readAlphaSenseCredentials.mockReset();
  mocks.readAlphaSenseCredentials.mockReturnValue({ credentials: CREDENTIALS, missing: [] });
  mocks.recordCall.mockReset().mockResolvedValue({ id: 'call-1' });
  mocks.getActiveWorkspaceId.mockClear();
});

afterEach(() => vi.clearAllMocks());

describe('alphasense_search tool', () => {
  it('returns the GenSearch markdown with a header and source footer', async () => {
    mocks.runGenSearch.mockResolvedValueOnce({
      conversationId: 'conv-1',
      markdown: 'Apple reported $94.9B revenue [[1 • 10-K]].',
      progress: 1,
      timedOut: false,
    });

    const out = (await call({ prompt: 'Apple Q4 2024 results?' })) as string;

    expect(out).toContain("**AlphaSense Research — 'Apple Q4 2024 results?':**");
    expect(out).toContain('Apple reported $94.9B revenue [[1 • 10-K]].');
    expect(out).toContain('Source: AlphaSense GenSearch');
    expect(out).not.toContain('Partial answer');
    expect(mocks.runGenSearch).toHaveBeenCalledWith('Apple Q4 2024 results?', { timeoutMs: 150_000 });
  });

  it('flags a partial answer when the poll budget elapses before completion', async () => {
    mocks.runGenSearch.mockResolvedValueOnce({
      conversationId: 'conv-2',
      markdown: 'Partial findings so far.',
      progress: 0.45,
      timedOut: true,
    });

    const out = (await call({ prompt: 'Nvidia data center outlook?' })) as string;

    expect(out).toContain('Partial answer: generation was still at 45%');
    expect(out).toContain('Partial findings so far.');
  });

  it('explains which env vars are missing instead of calling the API', async () => {
    mocks.readAlphaSenseCredentials.mockReturnValue({
      credentials: null,
      missing: ['ALPHASENSE_API_KEY', 'ALPHASENSE_PASSWORD'],
    });

    const out = (await call({ prompt: 'Any question' })) as string;

    expect(out).toContain('AlphaSense search is not available');
    expect(out).toContain('ALPHASENSE_API_KEY, ALPHASENSE_PASSWORD are not set');
    expect(out).toContain('valyu_search');
    expect(mocks.runGenSearch).not.toHaveBeenCalled();
  });

  it('reports an empty completed answer as a rephrase suggestion', async () => {
    mocks.runGenSearch.mockResolvedValueOnce({
      conversationId: 'conv-3',
      markdown: '   ',
      progress: 1,
      timedOut: false,
    });

    const out = (await call({ prompt: 'Obscure private co?' })) as string;

    expect(out).toContain('AlphaSense returned no content');
    expect(out).toContain('web_search');
  });

  it('reports an empty timed-out answer as a timeout, not an empty result', async () => {
    mocks.runGenSearch.mockResolvedValueOnce({
      conversationId: 'conv-4',
      markdown: '',
      progress: 0.1,
      timedOut: true,
    });

    const out = (await call({ prompt: 'Slow question' })) as string;

    expect(out).toContain('did not finish answering');
    expect(out).toContain('conv-4');
  });

  it('returns a readable error string when the API call throws', async () => {
    mocks.runGenSearch.mockRejectedValueOnce(new Error('AlphaSense GenSearch failed: RATE_LIMITED'));

    const out = (await call({ prompt: 'Anything' })) as string;

    expect(out).toContain('AlphaSense search error: AlphaSense GenSearch failed: RATE_LIMITED');
    expect(out).toContain('fallback');
  });
});

describe('alphasense_search tool call logging', () => {
  it('records a successful call with the chat thread id and original question from the runtime config', async () => {
    mocks.runGenSearch.mockResolvedValueOnce({
      conversationId: 'conv-1',
      markdown: 'Apple reported $94.9B revenue.',
      progress: 1,
      timedOut: false,
    });

    await call(
      { prompt: 'Apple Q4 2024 revenue?' },
      { configurable: { thread_id: 'thread-1', originalUserQuestion: 'How did Apple do last quarter?' } },
    );

    expect(mocks.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({
        chatThreadId: 'thread-1',
        originalQuestion: 'How did Apple do last quarter?',
        prompt: 'Apple Q4 2024 revenue?',
        conversationId: 'conv-1',
        status: 'success',
      }),
    );
  });

  it('records a null thread id and question when the runtime config carries none', async () => {
    mocks.runGenSearch.mockResolvedValueOnce({
      conversationId: 'conv-1',
      markdown: 'Answer.',
      progress: 1,
      timedOut: false,
    });

    await call({ prompt: 'Anything' });

    expect(mocks.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({ chatThreadId: null, originalQuestion: null }),
    );
  });

  it('records status timed_out when the poll budget elapses', async () => {
    mocks.runGenSearch.mockResolvedValueOnce({
      conversationId: 'conv-2',
      markdown: 'Partial findings.',
      progress: 0.45,
      timedOut: true,
    });

    await call({ prompt: 'Slow question' });

    expect(mocks.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'timed_out', conversationId: 'conv-2' }),
    );
  });

  it('records status not_configured without calling the API', async () => {
    mocks.readAlphaSenseCredentials.mockReturnValue({
      credentials: null,
      missing: ['ALPHASENSE_API_KEY'],
    });

    await call({ prompt: 'Any question' });

    expect(mocks.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'not_configured' }),
    );
  });

  it('records status error with the thrown message when the API call throws', async () => {
    mocks.runGenSearch.mockRejectedValueOnce(new Error('AlphaSense GenSearch failed: RATE_LIMITED'));

    await call({ prompt: 'Anything' });

    expect(mocks.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'error',
        errorMessage: 'AlphaSense GenSearch failed: RATE_LIMITED',
      }),
    );
  });

  it('still returns the answer to the agent when logging itself fails', async () => {
    mocks.runGenSearch.mockResolvedValueOnce({
      conversationId: 'conv-1',
      markdown: 'Apple reported $94.9B revenue.',
      progress: 1,
      timedOut: false,
    });
    mocks.recordCall.mockRejectedValueOnce(new Error('db unavailable'));

    const out = (await call({ prompt: 'Apple Q4 2024 revenue?' })) as string;

    expect(out).toContain('Apple reported $94.9B revenue.');
  });
});
