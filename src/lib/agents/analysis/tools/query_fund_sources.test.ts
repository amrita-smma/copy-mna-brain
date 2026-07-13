import { afterEach, describe, expect, it, vi } from 'vitest';

const listFundSourcesMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: vi.fn(async () => 'ws-1'),
}));

vi.mock('@/lib/services', () => ({
  createContainer: vi.fn(() => ({
    fundSourceService: { listFundSources: listFundSourcesMock },
  })),
}));

import { queryFundSources } from './query_fund_sources';

afterEach(() => vi.clearAllMocks());

describe('queryFundSources', () => {
  it('returns an empty-state message when there are no sources', async () => {
    listFundSourcesMock.mockResolvedValue([]);

    const result = (await queryFundSources.invoke({})) as string;

    expect(result).toContain('No fund sources (capital pools) found');
  });

  it('renders formatted metrics for each fund source', async () => {
    listFundSourcesMock.mockResolvedValue([
      {
        name: 'Balance Sheet',
        invested_amount: 40_000_000,
        realized_amount: 12_000_000,
        fmv_amount: 45_000_000,
        dpi: 0.3,
        moic: 1.42,
        irr: 0.19,
      },
    ]);

    const result = (await queryFundSources.invoke({})) as string;

    expect(result).toContain('**Fund sources (1):**');
    expect(result).toContain('Balance Sheet');
    expect(result).toContain('1.42x'); // moic
    expect(result).toContain('19.0%'); // irr
    expect(result).toContain('40,000,000');
  });
});
