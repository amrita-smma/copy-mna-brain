import { afterEach, describe, expect, it, vi } from 'vitest';

const getPortfolioMock = vi.fn();
const findInvestorsByIdsMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: vi.fn(async () => 'ws-1'),
}));

vi.mock('@/lib/repositories', () => ({
  FlInvestorRepository: vi.fn(function FlInvestorRepository() {
    return {
      findByIds: findInvestorsByIdsMock,
    };
  }),
}));

vi.mock('@/lib/services', () => ({
  createContainer: vi.fn(() => ({
    flPortfolioService: {
      getPortfolio: getPortfolioMock,
    },
  })),
}));

import { queryFundAssets } from './query_fund_assets';

afterEach(() => vi.clearAllMocks());

const mockPosition = (over: Record<string, unknown> = {}) => ({
  id: 'pos-1',
  holder_fund_id: 'f1',
  holder_fund: { id: 'f1', name: 'Fund I' },
  asset_id: 'a1',
  asset: {
    id: 'a1',
    name: 'Acme Holdco',
    asset_kind: 'direct_investment',
    sector: 'Software',
    status: 'active',
  },
  status: 'active',
  balances: {
    contributed: '5000000.00',
    distributed: '1000000.00',
  },
  valuation: {
    market_value: '8000000.00',
  },
  returns: {
    gross_moic: 1.8,
    dpi: 0.2,
    gross_irr: 0.22,
  },
  ...over,
});

describe('queryFundAssets', () => {
  it('lists assets across all funds plus unassigned when no fund filter is given', async () => {
    getPortfolioMock.mockResolvedValue({
      managed_funds: [{ id: 'f1', name: 'Fund I' }],
      positions: [mockPosition()],
      assets: [
        { id: 'a1', name: 'Acme Holdco', asset_kind: 'direct_investment', sector: 'Software' },
        { id: 'a2', name: 'Loose Asset', asset_kind: 'equity', sector: 'Tech' },
      ],
    });

    const result = (await queryFundAssets.invoke({})) as string;

    expect(result).toContain('Acme Holdco');
    expect(result).toContain('Fund I');
    expect(result).toContain('Loose Asset');
    expect(result).toContain('(unassigned)');
  });

  it('fetches every fund’s assets in ONE batched call rather than one call per fund', async () => {
    getPortfolioMock.mockResolvedValue({
      managed_funds: [
        { id: 'f1', name: 'Fund I' },
        { id: 'f2', name: 'Fund II' },
        { id: 'f3', name: 'Fund III' },
      ],
      positions: [mockPosition({ holder_fund_id: 'f2', holder_fund: { id: 'f2', name: 'Fund II' } })],
      assets: [],
    });

    await queryFundAssets.invoke({});

    expect(getPortfolioMock).toHaveBeenCalledTimes(1);
  });

  it('scopes to a single fund by partial name and skips unassigned assets', async () => {
    getPortfolioMock.mockResolvedValue({
      managed_funds: [
        { id: 'f1', name: 'Growth Fund II' },
        { id: 'f2', name: 'Credit Fund' },
      ],
      positions: [
        mockPosition({ holder_fund_id: 'f1', holder_fund: { id: 'f1', name: 'Growth Fund II' } }),
      ],
      assets: [{ id: 'a2', name: 'Loose Asset' }],
    });

    const result = (await queryFundAssets.invoke({ fund: 'growth' })) as string;

    expect(result).toContain('Acme Holdco');
    expect(result).toContain('Growth Fund II');
    expect(result).not.toContain('Loose Asset');
  });

  it('resolves a fund name fuzzily (legal suffix, punctuation, and typos)', async () => {
    getPortfolioMock.mockResolvedValue({
      managed_funds: [
        { id: 'f1', name: 'Growth Fund II, L.P.' },
        { id: 'f2', name: 'Credit Fund' },
      ],
      positions: [
        mockPosition({ holder_fund_id: 'f1', holder_fund: { id: 'f1', name: 'Growth Fund II, L.P.' } }),
      ],
      assets: [],
    });

    const res1 = await queryFundAssets.invoke({ fund: 'growth fund ii' });
    expect(res1).toContain('Acme Holdco');

    const res2 = await queryFundAssets.invoke({ fund: 'gowth fund ii' });
    expect(res2).toContain('Acme Holdco');
  });

  it('returns a not-found message pointing at search_investments when the fund name matches nothing', async () => {
    getPortfolioMock.mockResolvedValue({
      managed_funds: [{ id: 'f1', name: 'Growth Fund II' }],
      positions: [],
      assets: [],
    });

    const result = (await queryFundAssets.invoke({ fund: 'nonexistent' })) as string;

    expect(result).toContain('No fund found matching "nonexistent"');
    expect(result).toContain('search_investments');
  });

  it('filters assets by status', async () => {
    getPortfolioMock.mockResolvedValue({
      managed_funds: [{ id: 'f1', name: 'Fund I' }],
      positions: [
        mockPosition({
          asset: { id: 'a1', name: 'Live One', status: 'active' },
          status: 'active',
        }),
        mockPosition({
          asset: { id: 'a2', name: 'Sold One', status: 'exited' },
          status: 'exited',
        }),
      ],
      assets: [],
    });

    const result = (await queryFundAssets.invoke({ status: 'exited' })) as string;

    expect(result).toContain('Sold One');
    expect(result).not.toContain('Live One');
  });

  it('includes investor-held positions and renders <entity> (<group>) when entity has parent', async () => {
    findInvestorsByIdsMock
      .mockResolvedValueOnce([
        { id: 'inv-child', name: 'Tanaka Sub', parent_investor_id: 'inv-parent' },
      ])
      .mockResolvedValueOnce([
        { id: 'inv-parent', name: 'Tanaka Group', parent_investor_id: null },
      ]);

    getPortfolioMock.mockResolvedValue({
      managed_funds: [{ id: 'f1', name: 'Fund I' }],
      positions: [
        {
          id: 'pos-inv-1',
          holder_fund_id: null,
          holder_investor_id: 'inv-child',
          asset_id: 'a1',
          asset: { id: 'a1', name: 'Acme Holding', asset_kind: 'equity', sector: 'Tech' },
          status: 'active',
          balance: { contributed: '1000000', distributed: '0' },
          current_value: '2000000',
        },
      ],
      assets: [],
    });

    const result = (await queryFundAssets.invoke({})) as string;

    expect(result).toContain('Tanaka Sub (Tanaka Group)');
    expect(result).toContain('Acme Holding');
  });

  it('performs a single batched investor lookup for N positions without per-position queries', async () => {
    findInvestorsByIdsMock.mockResolvedValueOnce([
      { id: 'inv-1', name: 'Investor Alpha', parent_investor_id: null },
      { id: 'inv-2', name: 'Investor Beta', parent_investor_id: null },
    ]);

    getPortfolioMock.mockResolvedValue({
      managed_funds: [],
      positions: [
        {
          id: 'pos-1',
          holder_investor_id: 'inv-1',
          asset_id: 'a1',
          asset: { id: 'a1', name: 'Asset 1', asset_kind: 'equity' },
        },
        {
          id: 'pos-2',
          holder_investor_id: 'inv-1',
          asset_id: 'a2',
          asset: { id: 'a2', name: 'Asset 2', asset_kind: 'equity' },
        },
        {
          id: 'pos-3',
          holder_investor_id: 'inv-2',
          asset_id: 'a3',
          asset: { id: 'a3', name: 'Asset 3', asset_kind: 'equity' },
        },
      ],
      assets: [],
    });

    const result = (await queryFundAssets.invoke({})) as string;

    expect(findInvestorsByIdsMock).toHaveBeenCalledTimes(1);
    expect(findInvestorsByIdsMock).toHaveBeenCalledWith('ws-1', ['inv-1', 'inv-2']);
    expect(result).toContain('Investor Alpha');
    expect(result).toContain('Investor Beta');
  });
});
