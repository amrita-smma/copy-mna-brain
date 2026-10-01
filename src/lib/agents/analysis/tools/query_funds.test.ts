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
    flPortfolioService: { getPortfolio: getPortfolioMock },
  })),
}));

import { queryFunds } from './query_funds';

afterEach(() => vi.clearAllMocks());

describe('queryFunds', () => {
  it('returns an empty-state message when there are no funds', async () => {
    getPortfolioMock.mockResolvedValue({ managed_funds: [] });

    const result = (await queryFunds.invoke({})) as string;

    expect(result).toContain('No funds found in this workspace.');
  });

  it('renders a table row with formatted metrics derived from LP and portfolio positions', async () => {
    getPortfolioMock.mockResolvedValue({
      managed_funds: [
        {
          id: 'f1',
          name: 'Growth Fund II',
          vintage_year: 2021,
          status: 'investing',
        },
      ],
      positions: [
        // LP position targeting f1
        {
          id: 'lp-1',
          fund_id: 'f1',
          holder_investor_id: 'inv-1',
          holder_fund_id: null,
          asset_id: null,
          current_value: '0',
          balance: {
            commitment: '100000000.00',
            drawn_commitment: '60000000.00',
          },
        },
        // Portfolio position held by f1
        {
          id: 'port-1',
          fund_id: null,
          holder_investor_id: null,
          holder_fund_id: 'f1',
          asset_id: 'a1',
          current_value: '80000000.00',
          balance: {
            distributed_capital: '10000000.00',
          },
        },
      ],
    });

    const result = (await queryFunds.invoke({})) as string;

    expect(result).toContain('**Funds (1):**');
    expect(result).toContain('Growth Fund II');
    expect(result).toContain('100,000,000'); // commitment
    expect(result).toContain('60,000,000'); // called
    expect(result).toContain('80,000,000'); // fmv
    expect(result).toContain('10,000,000'); // realized
    expect(result).toContain('0.17x'); // dpi (10M / 60M)
    expect(result).toContain('1.50x'); // tvpi ((80M + 10M) / 60M)
  });

  it('filters by status case-insensitively', async () => {
    getPortfolioMock.mockResolvedValue({
      managed_funds: [
        { id: 'f1', name: 'Active Fund', status: 'investing' },
        { id: 'f2', name: 'Old Fund', status: 'closed' },
      ],
    });

    const result = (await queryFunds.invoke({ status: 'CLOSED' })) as string;

    expect(result).toContain('Old Fund');
    expect(result).not.toContain('Active Fund');
  });

  it('reports when no fund matches the status filter', async () => {
    getPortfolioMock.mockResolvedValue({
      managed_funds: [{ id: 'f1', name: 'Active Fund', status: 'investing' }],
    });

    const result = (await queryFunds.invoke({ status: 'harvesting' })) as string;

    expect(result).toContain('No funds found with status "harvesting".');
  });

  it('preserves exact decimal totals above 2^53 without floating-point precision loss', async () => {
    getPortfolioMock.mockResolvedValue({
      managed_funds: [
        {
          id: 'f-mega',
          name: 'Mega Precision Fund',
          vintage_year: 2024,
          status: 'investing',
        },
      ],
      positions: [
        // LP position 1: 9007199254740993 (which exceeds 2^53 = 9007199254740992)
        {
          id: 'lp-1',
          fund_id: 'f-mega',
          holder_investor_id: 'inv-1',
          current_value: '0',
          balance: {
            commitment: '9007199254740993.00',
            drawn_commitment: '9007199254740993.00',
          },
        },
        // LP position 2: +2.00 (in float math, 9007199254740993 + 2 evaluates to 9007199254740994)
        {
          id: 'lp-2',
          fund_id: 'f-mega',
          holder_investor_id: 'inv-2',
          current_value: '0',
          balance: {
            commitment: '2.00',
            drawn_commitment: '2.00',
          },
        },
        // Portfolio position: 9007199254740993 + 2 FMV
        {
          id: 'port-1',
          holder_fund_id: 'f-mega',
          current_value: '9007199254740993.00',
          balance: {
            distributed_capital: '2.00',
          },
        },
      ],
    });

    const result = (await queryFunds.invoke({})) as string;

    // Exact sum must be 9,007,199,254,740,995 (ends in ...995, not ...994)
    expect(result).toContain('9,007,199,254,740,995');
  });

  it('excludes cash positions from realized distributions', async () => {
    getPortfolioMock.mockResolvedValue({
      managed_funds: [
        { id: 'f1', name: 'Fund Cash Test', status: 'investing' },
      ],
      fund_cash_summaries: {
        f1: {
          cash_ledger_active: true,
          reporting_total_available: true,
          reporting_total: '3000000.00',
          cash_balances: [{ currency: 'USD', amount: '3000000.00' }],
        },
      },
      positions: [
        {
          id: 'lp-1',
          fund_id: 'f1',
          holder_investor_id: 'inv-1',
          current_value: '0',
          balance: {
            commitment: '10000000.00',
            drawn_commitment: '10000000.00',
          },
        },
        // Cash position with balance
        {
          id: 'pos-cash',
          holder_fund_id: 'f1',
          asset: { asset_kind: 'cash' },
          current_value: '3000000.00',
          balance: {
            asset_kind: 'cash',
            distributed_capital: '3000000.00', // Cash bank balance, not a distribution!
          },
        },
        // Equity position
        {
          id: 'pos-equity',
          holder_fund_id: 'f1',
          asset: { asset_kind: 'equity' },
          current_value: '7000000.00',
          balance: {
            asset_kind: 'equity',
            distributed_capital: '2000000.00', // Real distribution
          },
        },
      ],
    });

    const result = (await queryFunds.invoke({})) as string;

    // Realized should only be 2,000,000 (from equity), NOT 5,000,000
    expect(result).toContain('2,000,000');
    // FMV includes equity holdings (7M) + served reporting cash (3M) = 10,000,000
    expect(result).toContain('10,000,000');
    // DPI: 2M / 10M = 0.20x (NOT 0.50x)
    expect(result).toContain('0.20x');
    // Cash detail listed
    expect(result).toContain('Cash: USD 3,000,000');
  });

  it('handles pending-FX funds: displays Pending FX, leaves TVPI unavailable, and exposes per-currency cash', async () => {
    getPortfolioMock.mockResolvedValue({
      managed_funds: [
        { id: 'f-multi', name: 'Global Multi Fund', status: 'investing', vintage_year: 2023 },
      ],
      fund_cash_summaries: {
        'f-multi': {
          reporting_total_available: false,
          reporting_total: null,
          fx_status: 'pending_fx',
          cash_balances: [
            { currency: 'EUR', amount: '2000000.00' },
            { currency: 'USD', amount: '5000000.00' },
          ],
        },
      },
      positions: [
        {
          id: 'lp-1',
          fund_id: 'f-multi',
          holder_investor_id: 'inv-1',
          current_value: '0',
          balance: {
            commitment: '20000000.00',
            drawn_commitment: '15000000.00',
          },
        },
        {
          id: 'port-1',
          holder_fund_id: 'f-multi',
          asset: { asset_kind: 'equity' },
          current_value: '18000000.00',
          balance: {
            asset_kind: 'equity',
            distributed_capital: '3000000.00',
          },
        },
        {
          id: 'port-cash-usd',
          holder_fund_id: 'f-multi',
          asset: { asset_kind: 'cash' },
          current_value: '5000000.00',
          balance: { asset_kind: 'cash' },
        },
        {
          id: 'port-cash-eur',
          holder_fund_id: 'f-multi',
          asset: { asset_kind: 'cash' },
          current_value: '2000000.00',
          balance: { asset_kind: 'cash' },
        },
      ],
    });

    const result = (await queryFunds.invoke({})) as string;

    // FMV must display "Pending FX" instead of nominal sum (18M + 5M + 2M = 25M is FORBIDDEN)
    expect(result).toContain('Pending FX');
    expect(result).not.toContain('25,000,000');
    // TVPI is unavailable (-)
    expect(result).toMatch(/\|\s*-\s*\|\s*-\s*\|/); // TVPI is -, IRR is -
    // Realized is 3M, DPI is 0.20x
    expect(result).toContain('3,000,000');
    expect(result).toContain('0.20x');
    // Per-currency cash balances exposed
    expect(result).toContain('Cash: EUR 2,000,000, USD 5,000,000');
  });

  it('handles funds without cash positions', async () => {
    getPortfolioMock.mockResolvedValue({
      managed_funds: [
        { id: 'f-nocash', name: 'No Cash Fund', status: 'harvesting', vintage_year: 2018 },
      ],
      fund_cash_summaries: {
        'f-nocash': {
          reporting_total_available: true,
          reporting_total: '0.00000000',
          fx_status: 'available',
          cash_balances: [],
        },
      },
      positions: [
        {
          id: 'lp-1',
          fund_id: 'f-nocash',
          holder_investor_id: 'inv-1',
          current_value: '0',
          balance: {
            commitment: '50000000.00',
            drawn_commitment: '50000000.00',
          },
        },
        {
          id: 'port-1',
          holder_fund_id: 'f-nocash',
          asset: { asset_kind: 'equity' },
          current_value: '30000000.00',
          balance: {
            asset_kind: 'equity',
            distributed_capital: '25000000.00',
          },
        },
      ],
    });

    const result = (await queryFunds.invoke({})) as string;

    // FMV includes equity holdings (30M) = 30,000,000
    expect(result).toContain('30,000,000');
    // Realized is 25M
    expect(result).toContain('25,000,000');
    // TVPI: (30M + 25M) / 50M = 1.10x
    expect(result).toContain('1.10x');
    // No cash detail shown
    expect(result).not.toContain('Cash:');
    expect(result).not.toContain('Retained:');
  });

  it('includes investor-held positions and renders <entity> (<group>) when entity has a parent', async () => {
    findInvestorsByIdsMock
      .mockResolvedValueOnce([
        { id: 'inv-child', name: 'Tanaka Sub', parent_investor_id: 'inv-parent' },
      ])
      .mockResolvedValueOnce([
        { id: 'inv-parent', name: 'Tanaka Group', parent_investor_id: null },
      ]);

    getPortfolioMock.mockResolvedValue({
      managed_funds: [{ id: 'f1', name: 'Fund I', vintage_year: 2021, status: 'active', base_currency: 'USD' }],
      positions: [
        {
          id: 'pos-inv-1',
          holder_fund_id: null,
          holder_investor_id: 'inv-child',
          asset_id: 'a1',
          asset: { id: 'a1', name: 'Asset Alpha', asset_kind: 'equity' },
          current_value: '5000000.00',
          balance: {
            commitment: '4000000.00',
            drawn_commitment: '4000000.00',
            distributed_capital: '1000000.00',
          },
        },
      ],
    });

    const result = (await queryFunds.invoke({})) as string;

    expect(result).toContain('Tanaka Sub (Tanaka Group)');
    expect(result).toContain('5,000,000');
    expect(result).toContain('1,000,000');
    expect(result).toContain('Fund I');
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
          current_value: '1000000',
        },
        {
          id: 'pos-2',
          holder_investor_id: 'inv-1',
          asset_id: 'a2',
          asset: { id: 'a2', name: 'Asset 2', asset_kind: 'equity' },
          current_value: '2000000',
        },
        {
          id: 'pos-3',
          holder_investor_id: 'inv-2',
          asset_id: 'a3',
          asset: { id: 'a3', name: 'Asset 3', asset_kind: 'equity' },
          current_value: '3000000',
        },
      ],
    });

    const result = (await queryFunds.invoke({})) as string;

    expect(findInvestorsByIdsMock).toHaveBeenCalledTimes(1);
    expect(findInvestorsByIdsMock).toHaveBeenCalledWith('ws-1', ['inv-1', 'inv-2']);
    expect(result).toContain('Investor Alpha');
    expect(result).toContain('Investor Beta');
  });

  it('counts a managed fund held by another managed fund as an LP of the target without double counting the holder', async () => {
    getPortfolioMock.mockResolvedValue({
      managed_funds: [
        { id: 'f-hua', name: 'Huaian Xihe', vintage_year: 2024, status: 'investing' },
        { id: 'f-yue', name: 'Yuesheng Xingfan', vintage_year: 2024, status: 'investing' },
      ],
      positions: [
        // Outside LP of Huaian
        {
          id: 'lp-out',
          fund_id: 'f-hua',
          holder_investor_id: 'inv-1',
          holder_fund_id: null,
          asset_id: null,
          current_value: '0',
          balance: { commitment: '75000000.00', drawn_commitment: '14000000.00' },
        },
        // Yuesheng's fund-held position in Huaian: Huaian's LP, Yuesheng's holding
        {
          id: 'fof-yue-hua',
          fund_id: 'f-hua',
          holder_investor_id: null,
          holder_fund_id: 'f-yue',
          asset_id: null,
          current_value: '29000000.00',
          balance: { commitment: '95500000.00', drawn_commitment: '29000000.00' },
        },
      ],
    });

    const result = (await queryFunds.invoke({})) as string;
    const huaianRow = result.split('\n').find((line) => line.startsWith('| Huaian Xihe'))!;
    const yueshengRow = result.split('\n').find((line) => line.startsWith('| Yuesheng Xingfan'))!;

    expect(huaianRow).toContain('170,500,000'); // 75M + 95.5M commitment
    expect(huaianRow).toContain('43,000,000'); // 14M + 29M called
    // The holder carries the position as a holding (FMV), never as its own LP commitment.
    expect(yueshengRow).toContain('29,000,000');
    expect(yueshengRow).not.toContain('95,500,000');
  });
});
