import { afterEach, describe, expect, it, vi } from 'vitest';

const listFundsMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: vi.fn(async () => 'ws-1'),
}));

vi.mock('@/lib/services', () => ({
  createContainer: vi.fn(() => ({
    flMasterDataService: { listFunds: listFundsMock },
  })),
}));

import { getFundDataSchema } from './get_fund_data_schema';

afterEach(() => vi.clearAllMocks());

describe('getFundDataSchema', () => {
  it('describes the four fund-domain tables and their query tools', async () => {
    listFundsMock.mockResolvedValue([{ id: 'f1' }, { id: 'f2' }]);

    const result = (await getFundDataSchema.invoke({})) as string;

    expect(result).toContain('tracks **2** fund(s)');
    expect(result).toContain('query_funds');
    expect(result).toContain('query_fund_assets');
    expect(result).toContain('get_fund_asset_details');
    expect(result).toContain('query_investors');
    expect(result).toContain('query_fund_sources');
  });

  it('still returns the schema when the fund count lookup fails', async () => {
    listFundsMock.mockRejectedValue(new Error('db down'));

    const result = (await getFundDataSchema.invoke({})) as string;

    expect(result).toContain('tracks **0** fund(s)');
    expect(result).toContain('Fund & Investment Data Schema');
  });
});
