import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const searchByNameOrDescriptionMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/repositories', () => ({
  InvenCacheRepository: function InvenCacheRepository() {
    return { searchByNameOrDescription: searchByNameOrDescriptionMock };
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: function Anthropic() {
    return {
      messages: { create: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{}' }] }) },
    };
  },
}));

import { invenPaidDataSourceSearch } from './inven_paid_data_source_search';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  delete process.env.INVEN_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
});

afterEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = originalFetch;
});

describe('invenPaidDataSourceSearch', () => {
  it('serves cached results without calling the Inven API', async () => {
    searchByNameOrDescriptionMock.mockResolvedValue([
      { inven_company_id: 'IC1', inven_company_name: 'Acme', domain: 'acme.com', website: 'https://acme.com' },
    ]);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as any;

    const result = (await invenPaidDataSourceSearch.invoke({
      search_prompt: 'Acme',
    })) as string;

    expect(result).toContain('Cached Results (1 companies)');
    expect(result).toContain('Acme');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports the missing API key when cache is empty and INVEN_API_KEY is not set', async () => {
    searchByNameOrDescriptionMock.mockResolvedValue([]);

    const result = (await invenPaidDataSourceSearch.invoke({
      search_prompt: 'Petrochemical',
    })) as string;

    expect(result).toContain('INVEN_API_KEY environment variable is not set');
  });

  it('formats Inven API search results when cache misses', async () => {
    searchByNameOrDescriptionMock.mockResolvedValue([]);
    process.env.INVEN_API_KEY = 'token';

    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        companies: [
          { companyId: 'IC9', companyName: 'NewCo', domain: 'newco.com', website: 'https://newco.com' },
        ],
      }),
    });
    globalThis.fetch = fetchSpy as any;

    const result = (await invenPaidDataSourceSearch.invoke({
      search_prompt: 'tech in US',
      number_of_results: 5,
    })) as string;

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.inven.ai/public-api/v1/company-search',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toContain('Inven Search Results (1 companies)');
    expect(result).toContain('NewCo');
    expect(result).toContain('IC9');
  });
});
