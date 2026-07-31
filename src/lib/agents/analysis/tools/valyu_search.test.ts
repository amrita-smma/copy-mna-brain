import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const searchMock = vi.fn();

vi.mock('valyu-js', () => ({
  Valyu: function Valyu() {
    return { search: searchMock };
  },
}));

import { valyuSearch } from './valyu_search';

beforeEach(() => {
  process.env.VALYU_API_KEY = 'test-key';
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.VALYU_API_KEY;
});

describe('valyuSearch', () => {
  it('reports that the API key is missing when env is not configured', async () => {
    delete process.env.VALYU_API_KEY;

    const result = (await valyuSearch.invoke({
      query: 'How is AI transforming drug discovery?',
    })) as string;

    expect(result).toContain('VALYU_API_KEY environment variable is not set');
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('returns formatted results with citations from the Valyu response', async () => {
    searchMock.mockResolvedValue({
      success: true,
      results: [
        {
          title: 'AI in Drug Discovery',
          url: 'https://example.com/ai-drug',
          content: 'AI is accelerating target identification.',
          source: 'web',
          relevance_score: 0.91,
        },
      ],
    });

    const result = (await valyuSearch.invoke({
      query: 'How is AI transforming drug discovery?',
    })) as string;

    expect(searchMock).toHaveBeenCalledWith(
      'How is AI transforming drug discovery?',
      {},
    );
    expect(result).toContain(
      "Valyu Search Results for 'How is AI transforming drug discovery?'",
    );
    expect(result).toContain('AI is accelerating target identification.');
    expect(result).toContain('[AI in Drug Discovery](https://example.com/ai-drug)');
    expect(result).toContain('CITATIONS_JSON:');
  });

  it('surfaces Valyu API failures', async () => {
    searchMock.mockResolvedValue({
      success: false,
      error: 'quota exceeded',
      results: [],
    });

    const result = (await valyuSearch.invoke({ query: 'PE benchmarks' })) as string;

    expect(result).toContain('Valyu search error: quota exceeded');
  });
});
