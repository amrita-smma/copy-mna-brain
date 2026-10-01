import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FundCatalogCheckService } from './fundCatalogCheckService';
import type { FundCatalogItem } from '@/lib/fund_updates/types';

const mocks = vi.hoisted(() => ({
  findFunds: vi.fn(),
  findByFundIds: vi.fn(),
  findByHolderFundIds: vi.fn(),
  findAssetsByIds: vi.fn(),
  getPositionBalances: vi.fn(),
}));

class MockFundRepo {
  findByWorkspaceId = mocks.findFunds;
}
class MockPositionRepo {
  findByFundIds = mocks.findByFundIds;
  findByHolderFundIds = mocks.findByHolderFundIds;
}
class MockAssetRepo {
  findByIds = mocks.findAssetsByIds;
}
class MockBalanceService {
  getPositionBalances = mocks.getPositionBalances;
}

const WS = 'ws-1';

function makeService() {
  return new FundCatalogCheckService(
    WS,
    new MockFundRepo() as never,
    new MockPositionRepo() as never,
    new MockAssetRepo() as never,
    new MockBalanceService() as never,
  );
}

function catalogItem(overrides: Partial<FundCatalogItem> & { nameZh: string }): FundCatalogItem {
  return {
    filingCode: null,
    subscribedAmount: 100,
    paidInAmount: 60,
    investedAmount: 50,
    netCashFlowAmount: 10,
    ...overrides,
  };
}

function balance(
  position_id: string,
  fields: { committed?: string; contributed?: string; paid_in_adjustment?: string; cash_total?: string; asset_kind?: string | null },
) {
  return {
    position_id,
    asset_kind: fields.asset_kind ?? null,
    committed: fields.committed ?? '0',
    contributed: fields.contributed ?? '0',
    paid_in_adjustment: fields.paid_in_adjustment ?? '0',
    unfunded: '0',
    quantity: '0',
    cash_total: fields.cash_total ?? '0',
    distributed: '0',
  };
}

const fundA = { id: 'fund-a', name: '基金甲', managed: true, base_currency: 'CNY' };
const fundB = { id: 'fund-b', name: '基金乙', managed: true, base_currency: 'CNY' };
const unrelated = { id: 'fund-x', name: '其他基金', managed: false, base_currency: 'USD' };

describe('FundCatalogCheckService.checkAgainstCatalog', () => {
  beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
  });

  it('returns an empty result without hitting the DB when no catalog fund states figures', async () => {
    const result = await makeService().checkAgainstCatalog([
      catalogItem({ nameZh: '基金甲', subscribedAmount: null, paidInAmount: null, investedAmount: null }),
    ]);
    expect(result).toEqual({
      checked_funds: 0,
      differences: [],
      skipped_funds: [],
      missing_funds: [],
      warnings: [],
      notes: [],
    });
    expect(mocks.findFunds).not.toHaveBeenCalled();
    expect(mocks.getPositionBalances).not.toHaveBeenCalled();
  });

  it('totals LP commitments, paid-in, holdings cost and CNY cash per fund in one batched pass', async () => {
    mocks.findFunds.mockResolvedValue([fundA, fundB, unrelated]);
    mocks.findByFundIds.mockResolvedValue([
      // Outside LP of A, and managed fund B's fund-held LP position in A.
      { id: 'lp-1', fund_id: 'fund-a', asset_id: null, holder_investor_id: 'inv-1', holder_fund_id: null },
      { id: 'b-in-a', fund_id: 'fund-a', asset_id: null, holder_investor_id: null, holder_fund_id: 'fund-b' },
      // A's own fund-held position in itself is never its LP.
      { id: 'self', fund_id: 'fund-a', asset_id: null, holder_investor_id: null, holder_fund_id: 'fund-a' },
    ]);
    mocks.findByHolderFundIds.mockResolvedValue([
      { id: 'a-holds-co', holder_fund_id: 'fund-a', asset_id: 'asset-co', fund_id: null },
      { id: 'a-cash', holder_fund_id: 'fund-a', asset_id: 'asset-cash', fund_id: null },
      // B's fund-of-funds holding in A: B's invested.
      { id: 'b-in-a', holder_fund_id: 'fund-b', asset_id: null, fund_id: 'fund-a' },
    ]);
    mocks.findAssetsByIds.mockResolvedValue([
      { id: 'asset-co', asset_kind: 'company' },
      { id: 'asset-cash', asset_kind: 'cash', instrument_terms: { currency: 'CNY' } },
    ]);
    mocks.getPositionBalances.mockResolvedValue([
      balance('lp-1', { committed: '60', contributed: '40' }),
      balance('b-in-a', { committed: '40', contributed: '20' }),
      balance('self', { committed: '999', contributed: '999' }),
      balance('a-holds-co', { contributed: '50' }),
      balance('a-cash', { cash_total: '10', asset_kind: 'cash' }),
    ]);

    const result = await makeService().checkAgainstCatalog([
      catalogItem({ nameZh: '基金甲' }),
      catalogItem({ nameZh: '基金乙', subscribedAmount: 0, paidInAmount: 0, investedAmount: 20, netCashFlowAmount: 0 }),
    ]);

    expect(result.checked_funds).toBe(2);
    expect(result.differences).toEqual([]);

    expect(mocks.findByFundIds).toHaveBeenCalledTimes(1);
    expect(mocks.findByFundIds).toHaveBeenCalledWith(WS, ['fund-a', 'fund-b'], undefined);
    expect(mocks.findByHolderFundIds).toHaveBeenCalledWith(WS, ['fund-a', 'fund-b'], undefined);
    expect(mocks.getPositionBalances).toHaveBeenCalledTimes(1);
    expect(mocks.getPositionBalances.mock.calls[0][1]).toEqual(['lp-1', 'b-in-a', 'self', 'a-holds-co', 'a-cash']);
    expect(mocks.findAssetsByIds).toHaveBeenCalledWith(WS, ['asset-co', 'asset-cash'], undefined);
  });

  it('flags a second paid-in on an investor-held LP position as posting differences on paid-in and cash (MB-569)', async () => {
    // 基金甲 receives 29M from managed fund 基金乙 (fund-held LP position) and
    // 18M from an outside LP. The bug wrote the 29M again on an investor-held
    // position, so paid-in reads 76M and cash 30M against rows of 47M and 1M.
    mocks.findFunds.mockResolvedValue([fundA, fundB]);
    mocks.findByFundIds.mockResolvedValue([
      { id: 'b-in-a', fund_id: 'fund-a', asset_id: null, holder_investor_id: null, holder_fund_id: 'fund-b' },
      { id: 'lp-1', fund_id: 'fund-a', asset_id: null, holder_investor_id: 'inv-1', holder_fund_id: null },
      { id: 'dup', fund_id: 'fund-a', asset_id: null, holder_investor_id: 'inv-b', holder_fund_id: null },
    ]);
    mocks.findByHolderFundIds.mockResolvedValue([
      { id: 'a-cash', holder_fund_id: 'fund-a', asset_id: 'asset-cash', fund_id: null },
      { id: 'b-in-a', holder_fund_id: 'fund-b', asset_id: null, fund_id: 'fund-a' },
    ]);
    mocks.findAssetsByIds.mockResolvedValue([
      { id: 'asset-cash', asset_kind: 'cash', instrument_terms: { currency: 'CNY' } },
    ]);
    mocks.getPositionBalances.mockResolvedValue([
      balance('b-in-a', { committed: '29000000', contributed: '29000000' }),
      balance('lp-1', { committed: '221000000', contributed: '18000000' }),
      balance('dup', { contributed: '29000000' }),
      balance('a-cash', { cash_total: '30000000', asset_kind: 'cash' }),
    ]);

    const result = await makeService().checkAgainstCatalog(
      [
        catalogItem({ nameZh: '基金甲', subscribedAmount: 250_000_000, paidInAmount: 47_000_000, investedAmount: 0, netCashFlowAmount: 1_000_000 }),
        catalogItem({ nameZh: '基金乙', subscribedAmount: 0, paidInAmount: 0, investedAmount: 29_000_000, netCashFlowAmount: 0 }),
      ],
      {
        rowFigures: new Map([
          ['基金甲', { committed: 250_000_000, paidIn: 47_000_000, invested: 0 }],
          ['基金乙', { committed: 0, paidIn: 0, invested: 29_000_000 }],
        ]),
      },
    );

    expect(result.differences).toEqual([
      { fund: '基金甲', metric: 'paid_in', kind: 'posting', ledgerValue: 76_000_000, rowsValue: 47_000_000, catalogValue: 47_000_000, diff: 29_000_000 },
      { fund: '基金甲', metric: 'cash', kind: 'posting', ledgerValue: 30_000_000, rowsValue: 1_000_000, catalogValue: 1_000_000, diff: 29_000_000 },
    ]);
  });

  it('compares cash paid-in with the rows, leaving a posted write-off out', async () => {
    mocks.findFunds.mockResolvedValue([fundA]);
    mocks.findByFundIds.mockResolvedValue([
      { id: 'lp-1', fund_id: 'fund-a', asset_id: null, holder_investor_id: 'inv-1', holder_fund_id: null },
    ]);
    mocks.findByHolderFundIds.mockResolvedValue([]);
    mocks.findAssetsByIds.mockResolvedValue([]);
    mocks.getPositionBalances.mockResolvedValue([
      // 60 cash paid-in less a 5 write-off: the fund view shows 55.
      balance('lp-1', { committed: '100', contributed: '55', paid_in_adjustment: '-5' }),
    ]);

    const result = await makeService().checkAgainstCatalog(
      [catalogItem({ nameZh: '基金甲', investedAmount: 0, netCashFlowAmount: undefined })],
      { rowFigures: new Map([['基金甲', { committed: 100, paidIn: 60, invested: 0 }]]) },
    );

    expect(result.differences).toEqual([]);
  });

  it('passes the executor through to every read', async () => {
    const executor = { tx: true } as never;
    mocks.findFunds.mockResolvedValue([fundA]);
    mocks.findByFundIds.mockResolvedValue([]);
    mocks.findByHolderFundIds.mockResolvedValue([]);
    mocks.findAssetsByIds.mockResolvedValue([]);
    mocks.getPositionBalances.mockResolvedValue([]);

    await makeService().checkAgainstCatalog([catalogItem({ nameZh: '基金甲' })], {}, executor);

    expect(mocks.findFunds).toHaveBeenCalledWith(WS, executor);
    expect(mocks.findByFundIds).toHaveBeenCalledWith(WS, ['fund-a'], executor);
    expect(mocks.findByHolderFundIds).toHaveBeenCalledWith(WS, ['fund-a'], executor);
    expect(mocks.getPositionBalances).toHaveBeenCalledWith(WS, [], null, executor);
    expect(mocks.findAssetsByIds).toHaveBeenCalledWith(WS, [], executor);
  });

  it('lists a catalog fund with no ledger fund as missing', async () => {
    mocks.findFunds.mockResolvedValue([unrelated]);
    mocks.findByFundIds.mockResolvedValue([]);
    mocks.findByHolderFundIds.mockResolvedValue([]);
    mocks.findAssetsByIds.mockResolvedValue([]);
    mocks.getPositionBalances.mockResolvedValue([]);

    const result = await makeService().checkAgainstCatalog([catalogItem({ nameZh: '基金甲' })]);

    expect(result.missing_funds).toEqual(['基金甲']);
    expect(mocks.findByFundIds).toHaveBeenCalledWith(WS, [], undefined);
  });
});
