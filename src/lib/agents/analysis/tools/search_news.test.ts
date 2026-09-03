import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  createDb: vi.fn(() => ({})),
  searchNewsImpl: vi.fn(),
  embed: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: mocks.createDb }));
vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/lib/repositories', () => ({
  RssItemRepository: class {},
  RssItemChunkRepository: class {},
}));
vi.mock('@/lib/bedrock', () => ({
  BedrockEmbeddingClient: class {
    embed = mocks.embed;
  },
}));
vi.mock('@/lib/services/dataNavigatorService', () => ({
  DataNavigatorService: class {
    searchNews = mocks.searchNewsImpl;
  },
}));

import { searchNews } from './search_news';

function hit(overrides: Record<string, unknown> = {}) {
  return {
    id: 'i1',
    title: 'Acme raises $40m Series B',
    source_name: 'DealStreetAsia',
    category: 'new_funding',
    published_at: '2026-09-02T08:00:00.000Z',
    link: 'https://example.com/acme',
    snippet: 'Acme Corp closed a $40m round led by Beta Ventures.',
    score: 0.91,
    matchedBy: 'both',
    language: 'en',
    translation_status: 'not_needed',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('search_news tool', () => {
  it('returns a markdown list of hits with source, date and link', async () => {
    mocks.searchNewsImpl.mockResolvedValueOnce([hit()]);

    const out = (await searchNews.invoke({ query: 'acme funding' })) as string;

    expect(out).toContain('Acme raises $40m Series B');
    expect(out).toContain('DealStreetAsia');
    expect(out).toContain('2026-09-02');
    expect(out).toContain('https://example.com/acme');
  });

  it('flags a machine-translated hit so the model does not quote it as verbatim', async () => {
    mocks.searchNewsImpl.mockResolvedValueOnce([
      hit({
        title: 'SoftBank buys additional Arm shares',
        language: 'ja',
        translation_status: 'translated',
      }),
    ]);

    const out = (await searchNews.invoke({ query: 'softbank arm' })) as string;

    expect(out).toContain('machine-translated from Japanese');
  });

  it('adds no provenance note for an item that needed no translation', async () => {
    mocks.searchNewsImpl.mockResolvedValueOnce([hit()]);

    const out = (await searchNews.invoke({ query: 'acme funding' })) as string;

    expect(out).not.toContain('machine-translated');
  });

  it('passes category and date filters through to the service', async () => {
    mocks.searchNewsImpl.mockResolvedValueOnce([]);

    await searchNews.invoke({
      query: 'semiconductor M&A',
      categories: ['ma_partnerships'],
      publishedAfter: '2026-08-01',
      topK: 5,
    });

    expect(mocks.searchNewsImpl).toHaveBeenCalledWith('semiconductor M&A', {
      topK: 5,
      categories: ['ma_partnerships'],
      from: '2026-08-01',
      selectedOnly: true,
    });
  });

  it('defaults to the curated (selectedOnly) subset so the agent never sees pending/rejected items', async () => {
    mocks.searchNewsImpl.mockResolvedValueOnce([]);

    await searchNews.invoke({ query: 'acme funding' });

    expect(mocks.searchNewsImpl).toHaveBeenCalledWith(
      'acme funding',
      expect.objectContaining({ selectedOnly: true }),
    );
  });

  it('rejects a blank query before touching the database', async () => {
    const out = (await searchNews.invoke({ query: '   ' })) as string;
    expect(out).toContain('**Error:**');
    expect(mocks.searchNewsImpl).not.toHaveBeenCalled();
  });

  it('tells the agent plainly when nothing matched', async () => {
    mocks.searchNewsImpl.mockResolvedValueOnce([]);
    const out = (await searchNews.invoke({ query: 'nothing' })) as string;
    expect(out).toMatch(/no .*news/i);
  });

  it('returns an error string rather than throwing when the search fails', async () => {
    mocks.searchNewsImpl.mockRejectedValueOnce(new Error('bedrock down'));
    const out = (await searchNews.invoke({ query: 'acme' })) as string;
    expect(out).toContain('**Error:**');
    expect(out).toContain('bedrock down');
  });

  it('handles an undated item without rendering "Invalid Date"', async () => {
    mocks.searchNewsImpl.mockResolvedValueOnce([hit({ published_at: null })]);
    const out = (await searchNews.invoke({ query: 'acme' })) as string;
    expect(out).not.toContain('Invalid Date');
    expect(out).toContain('undated');
  });
});
