import { afterEach, describe, expect, it, vi } from 'vitest';

const listFundsMock = vi.fn();
const listAssetsForFundsMock = vi.fn();
const listUnassignedAssetsMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: vi.fn(async () => 'ws-1'),
}));

vi.mock('@/lib/services', () => ({
  createContainer: vi.fn(() => ({
    fundService: {
      listFunds: listFundsMock,
      listAssetsForFunds: listAssetsForFundsMock,
      listUnassignedAssets: listUnassignedAssetsMock,
    },
  })),
}));

import { queryFundAssets } from './query_fund_assets';

afterEach(() => vi.clearAllMocks());

const asset = (over: Record<string, unknown> = {}) => ({
  asset_name: 'Acme Holdco',
  asset_type: 'direct_investment',
  sector: 'Software',
  status: 'active',
  invested_capital_amount: 5_000_000,
  net_distribution_amount: 1_000_000,
  fmv_amount: 8_000_000,
  gross_moic: 1.8,
  dpi: 0.2,
  gross_irr: 0.22,
  ...over,
});

describe('queryFundAssets', () => {
  it('lists assets across all funds plus unassigned when no fund filter is given', async () => {
    listFundsMock.mockResolvedValue([{ id: 'f1', name: 'Fund I' }]);
    listAssetsForFundsMock.mockResolvedValue([{ fundId: 'f1', asset: asset() }]);
    listUnassignedAssetsMock.mockResolvedValue([asset({ asset_name: 'Loose Asset' })]);

    const result = (await queryFundAssets.invoke({})) as string;

    expect(result).toContain('Acme Holdco');
    expect(result).toContain('Fund I');
    expect(result).toContain('Loose Asset');
    expect(result).toContain('(unassigned)');
    expect(listUnassignedAssetsMock).toHaveBeenCalled();
  });

  it('fetches every fund’s assets in ONE batched call rather than one call per fund', async () => {
    listFundsMock.mockResolvedValue([
      { id: 'f1', name: 'Fund I' },
      { id: 'f2', name: 'Fund II' },
      { id: 'f3', name: 'Fund III' },
    ]);
    listAssetsForFundsMock.mockResolvedValue([{ fundId: 'f2', asset: asset() }]);
    listUnassignedAssetsMock.mockResolvedValue([]);

    await queryFundAssets.invoke({});

    expect(listAssetsForFundsMock).toHaveBeenCalledTimes(1);
    expect(listAssetsForFundsMock).toHaveBeenCalledWith(['f1', 'f2', 'f3']);
  });

  it('scopes to a single fund by partial name and skips unassigned assets', async () => {
    listFundsMock.mockResolvedValue([
      { id: 'f1', name: 'Growth Fund II' },
      { id: 'f2', name: 'Credit Fund' },
    ]);
    listAssetsForFundsMock.mockResolvedValue([{ fundId: 'f1', asset: asset() }]);

    const result = (await queryFundAssets.invoke({ fund: 'growth' })) as string;

    expect(listAssetsForFundsMock).toHaveBeenCalledWith(['f1']);
    expect(listUnassignedAssetsMock).not.toHaveBeenCalled();
    expect(result).toContain('Acme Holdco');
    expect(result).toContain('Growth Fund II');
  });

  it('resolves a fund name fuzzily (legal suffix, punctuation, and typos)', async () => {
    listFundsMock.mockResolvedValue([
      { id: 'f1', name: 'Growth Fund II, L.P.' },
      { id: 'f2', name: 'Credit Fund' },
    ]);
    listAssetsForFundsMock.mockResolvedValue([{ fundId: 'f1', asset: asset() }]);

    await queryFundAssets.invoke({ fund: 'growth fund ii' });
    expect(listAssetsForFundsMock).toHaveBeenLastCalledWith(['f1']);

    await queryFundAssets.invoke({ fund: 'gowth fund ii' });
    expect(listAssetsForFundsMock).toHaveBeenLastCalledWith(['f1']);
  });

  it('returns a not-found message pointing at search_investments when the fund name matches nothing', async () => {
    listFundsMock.mockResolvedValue([{ id: 'f1', name: 'Growth Fund II' }]);

    const result = (await queryFundAssets.invoke({ fund: 'nonexistent' })) as string;

    expect(result).toContain('No fund found matching "nonexistent"');
    expect(result).toContain('search_investments');
    expect(listAssetsForFundsMock).not.toHaveBeenCalled();
  });

  it('filters assets by status', async () => {
    listFundsMock.mockResolvedValue([{ id: 'f1', name: 'Fund I' }]);
    listAssetsForFundsMock.mockResolvedValue([
      { fundId: 'f1', asset: asset({ asset_name: 'Live One', status: 'active' }) },
      { fundId: 'f1', asset: asset({ asset_name: 'Sold One', status: 'exited' }) },
    ]);
    listUnassignedAssetsMock.mockResolvedValue([]);

    const result = (await queryFundAssets.invoke({ status: 'exited' })) as string;

    expect(result).toContain('Sold One');
    expect(result).not.toContain('Live One');
  });
});
