import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  runGenSearch: vi.fn(),
  readAlphaSenseCredentials: vi.fn(),
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

import { alphasenseSearch } from './alphasense_search';

const CREDENTIALS = {
  apiKey: 'key-1',
  clientId: 'client-1',
  clientSecret: 'secret-1',
  email: 'analyst@example.com',
  password: 'pw',
};

beforeEach(() => {
  mocks.runGenSearch.mockReset();
  mocks.readAlphaSenseCredentials.mockReset();
  mocks.readAlphaSenseCredentials.mockReturnValue({ credentials: CREDENTIALS, missing: [] });
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

    const out = (await alphasenseSearch.invoke({ prompt: 'Apple Q4 2024 results?' })) as string;

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

    const out = (await alphasenseSearch.invoke({ prompt: 'Nvidia data center outlook?' })) as string;

    expect(out).toContain('Partial answer: generation was still at 45%');
    expect(out).toContain('Partial findings so far.');
  });

  it('explains which env vars are missing instead of calling the API', async () => {
    mocks.readAlphaSenseCredentials.mockReturnValue({
      credentials: null,
      missing: ['ALPHASENSE_API_KEY', 'ALPHASENSE_PASSWORD'],
    });

    const out = (await alphasenseSearch.invoke({ prompt: 'Any question' })) as string;

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

    const out = (await alphasenseSearch.invoke({ prompt: 'Obscure private co?' })) as string;

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

    const out = (await alphasenseSearch.invoke({ prompt: 'Slow question' })) as string;

    expect(out).toContain('did not finish answering');
    expect(out).toContain('conv-4');
  });

  it('returns a readable error string when the API call throws', async () => {
    mocks.runGenSearch.mockRejectedValueOnce(new Error('AlphaSense GenSearch failed: RATE_LIMITED'));

    const out = (await alphasenseSearch.invoke({ prompt: 'Anything' })) as string;

    expect(out).toContain('AlphaSense search error: AlphaSense GenSearch failed: RATE_LIMITED');
    expect(out).toContain('fallback');
  });
});
