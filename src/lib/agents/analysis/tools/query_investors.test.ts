import { afterEach, describe, expect, it, vi } from 'vitest';

const getPortfolioMock = vi.fn();

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: vi.fn(async () => 'ws-1'),
}));

vi.mock('@/lib/services', () => ({
  createContainer: vi.fn(() => ({
    flPortfolioService: { getPortfolio: getPortfolioMock },
  })),
}));

import { queryInvestors } from './query_investors';

afterEach(() => vi.clearAllMocks());

describe('queryInvestors', () => {
  it('returns an empty-state message when there are no investors', async () => {
    getPortfolioMock.mockResolvedValue({ investors: [] });

    const result = (await queryInvestors.invoke({})) as string;

    expect(result).toContain('No investors (LPs) found');
  });

  it('renders formatted metrics derived from investor-held positions', async () => {
    getPortfolioMock.mockResolvedValue({
      investors: [
        {
          id: 'inv-1',
          name: 'Pension Fund A',
          investor_type: 'institutional',
        },
      ],
      positions: [
        {
          id: 'pos-lp-1',
          holder_investor_id: 'inv-1',
          fund_id: 'fund-1',
          current_value: '30000000.00',
          balance: {
            drawn_commitment: '25000000.00',
            distributed_capital: '5000000.00',
          },
        },
      ],
    });

    const result = (await queryInvestors.invoke({})) as string;

    expect(result).toContain('**Investors / LPs (1):**');
    expect(result).toContain('Pension Fund A');
    expect(result).toContain('institutional');
    expect(result).toContain('25,000,000'); // invested
    expect(result).toContain('5,000,000'); // realized
    expect(result).toContain('30,000,000'); // fmv
    expect(result).toContain('0.20x'); // dpi (5M / 25M)
    expect(result).toContain('1.40x'); // moic ((30M + 5M) / 25M)
  });

  it('preserves exact decimal totals above 2^53 without floating-point precision loss', async () => {
    getPortfolioMock.mockResolvedValue({
      investors: [
        {
          id: 'inv-mega',
          name: 'Mega Precision LP',
          investor_type: 'institutional',
        },
      ],
      positions: [
        {
          id: 'pos-1',
          holder_investor_id: 'inv-mega',
          fund_id: 'fund-1',
          current_value: '9007199254740993.00',
          balance: {
            drawn_commitment: '9007199254740993.00',
            distributed_capital: '0',
          },
        },
        {
          id: 'pos-2',
          holder_investor_id: 'inv-mega',
          fund_id: 'fund-2',
          current_value: '2.00',
          balance: {
            drawn_commitment: '2.00',
            distributed_capital: '0',
          },
        },
      ],
    });

    const result = (await queryInvestors.invoke({})) as string;

    // Exact sum must be 9,007,199,254,740,995 (ends in ...995, not ...994)
    expect(result).toContain('Mega Precision LP');
    expect(result).toContain('9,007,199,254,740,995');
  });
});
