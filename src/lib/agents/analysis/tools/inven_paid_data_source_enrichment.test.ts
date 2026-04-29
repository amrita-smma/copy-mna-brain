import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const upsertMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/repositories', () => ({
  InvenCacheRepository: function InvenCacheRepository() {
    return { upsert: upsertMock };
  },
}));

import { invenPaidDataSourceEnrichment } from './inven_paid_data_source_enrichment';

const originalFetch = globalThis.fetch;

beforeEach(() => {
  delete process.env.INVEN_API_KEY;
});

afterEach(() => {
  vi.clearAllMocks();
  globalThis.fetch = originalFetch;
});

describe('invenPaidDataSourceEnrichment', () => {
  it('rejects calls with no company ids', async () => {
    const result = (await invenPaidDataSourceEnrichment.invoke({ company_ids: [] })) as string;

    expect(result).toContain('No company IDs provided');
  });

  it('refuses to call the API when INVEN_API_KEY is missing', async () => {
    const result = (await invenPaidDataSourceEnrichment.invoke({
      company_ids: ['IC1'],
    })) as string;

    expect(result).toContain('INVEN_API_KEY environment variable is not set');
  });

  it('caches each result and renders an enriched profile section per company', async () => {
    process.env.INVEN_API_KEY = 'token';
    upsertMock.mockResolvedValue(undefined);
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          {
            basic: {
              companyId: 'IC1',
              companyName: 'Acme',
              domain: 'acme.com',
              website: 'https://acme.com',
              description: 'A maker of widgets',
              employeeCount: 250,
              revenueEstimateUsdMillions: 75,
              ownership: 'public',
              headquarters: { countryCode: 'US' },
            },
          },
        ],
      }),
    }) as any;

    const result = (await invenPaidDataSourceEnrichment.invoke({
      company_ids: ['IC1'],
    })) as string;

    expect(upsertMock).toHaveBeenCalledWith(expect.objectContaining({ inven_company_id: 'IC1' }));
    expect(result).toContain('### Acme');
    expect(result).toContain('**Country:** US');
    expect(result).toContain('**Headcount:** 250');
    expect(result).toContain('$75M');
  });
});
