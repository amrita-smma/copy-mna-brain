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

import { queryFundSources } from './query_fund_sources';

afterEach(() => vi.clearAllMocks());

describe('queryFundSources', () => {
  it('returns an empty-state message when there are no sources', async () => {
    getPortfolioMock.mockResolvedValue({ funding_sources: [] });

    const result = (await queryFundSources.invoke({})) as string;

    expect(result).toContain('No fund sources (capital pools) found');
  });

  it('renders formatted metrics derived from allocations and sourced positions', async () => {
    getPortfolioMock.mockResolvedValue({
      funding_sources: [
        {
          id: 'fs-1',
          name: 'Balance Sheet',
        },
      ],
      positions: [
        {
          id: 'pos-1',
          holder_source_of_fund_id: 'fs-1',
          current_value: '45000000.00',
        },
      ],
      entries: [
        {
          id: 'e1',
          position_id: 'pos-1',
          entry_type: 'buy',
          cash_delta: '-40000000.00',
          is_reversal: false,
          allocations: [{ funding_source_id: 'fs-1', amount: '40000000.00' }],
        },
        {
          id: 'e2',
          position_id: 'pos-1',
          entry_type: 'distribution',
          cash_delta: '12000000.00',
          is_reversal: false,
          allocations: [{ funding_source_id: 'fs-1', amount: '12000000.00' }],
        },
      ],
    });

    const result = (await queryFundSources.invoke({})) as string;

    expect(result).toContain('**Fund sources (1):**');
    expect(result).toContain('Balance Sheet');
    expect(result).toContain('40,000,000'); // invested
    expect(result).toContain('12,000,000'); // realized
    expect(result).toContain('45,000,000'); // fmv
    expect(result).toContain('0.30x'); // dpi (12M / 40M)
    expect(result).toContain('1.43x'); // moic ((45M + 12M) / 40M)
  });

  it('does not guess FMV for NULL-source multi-source positions', async () => {
    getPortfolioMock.mockResolvedValue({
      funding_sources: [
        { id: 'fs-1', name: 'Source A' },
        { id: 'fs-2', name: 'Source B' },
      ],
      positions: [
        // NULL-source position (multi-source split)
        {
          id: 'pos-null-src',
          holder_source_of_fund_id: null,
          current_value: '50000000.00',
        },
        // Dedicated sourced position for Source A
        {
          id: 'pos-src-a',
          holder_source_of_fund_id: 'fs-1',
          current_value: '10000000.00',
        },
      ],
      entries: [
        {
          id: 'e1',
          position_id: 'pos-null-src',
          entry_type: 'buy',
          cash_delta: '-20000000.00',
          is_reversal: false,
          allocations: [
            { funding_source_id: 'fs-1', amount: '12000000.00' },
            { funding_source_id: 'fs-2', amount: '8000000.00' },
          ],
        },
      ],
    });

    const result = (await queryFundSources.invoke({})) as string;

    // Source A: 12M invested, 10M FMV from pos-src-a only (not 50M from pos-null-src)
    expect(result).toContain('Source A');
    expect(result).toContain('12,000,000');
    expect(result).toContain('10,000,000');
    expect(result).toContain('0.83x'); // (10M / 12M)

    // Source B: 8M invested, 0 FMV (not guessed from pos-null-src)
    expect(result).toContain('Source B');
    expect(result).toContain('8,000,000');
    expect(result).toContain('0.00x');
  });

  it('handles reversed buy entries by netting deploy-side to zero without affecting realize-side', async () => {
    getPortfolioMock.mockResolvedValue({
      funding_sources: [{ id: 'fs-1', name: 'Source A' }],
      positions: [{ id: 'pos-1', holder_source_of_fund_id: 'fs-1', current_value: '0' }],
      entries: [
        {
          id: 'e1',
          position_id: 'pos-1',
          entry_type: 'buy',
          cash_delta: '-5000000.00',
          is_reversal: false,
          allocations: [{ funding_source_id: 'fs-1', amount: '5000000.00' }],
        },
        {
          id: 'e1-rev',
          position_id: 'pos-1',
          entry_type: 'buy',
          cash_delta: '5000000.00',
          is_reversal: true,
          allocations: [{ funding_source_id: 'fs-1', amount: '5000000.00' }],
        },
      ],
    });

    const result = (await queryFundSources.invoke({})) as string;

    expect(result).toContain('Source A');
    expect(result).toContain('| Source A | 0 | 0 | 0 | - | - | - |');
  });

  it('handles reversed income entries by netting realize-side to zero without affecting deploy-side', async () => {
    getPortfolioMock.mockResolvedValue({
      funding_sources: [{ id: 'fs-1', name: 'Source A' }],
      positions: [{ id: 'pos-1', holder_source_of_fund_id: 'fs-1', current_value: '0' }],
      entries: [
        {
          id: 'e1',
          position_id: 'pos-1',
          entry_type: 'income',
          cash_delta: '2000000.00',
          is_reversal: false,
          allocations: [{ funding_source_id: 'fs-1', amount: '2000000.00' }],
        },
        {
          id: 'e1-rev',
          position_id: 'pos-1',
          entry_type: 'income',
          cash_delta: '-2000000.00',
          is_reversal: true,
          allocations: [{ funding_source_id: 'fs-1', amount: '2000000.00' }],
        },
      ],
    });

    const result = (await queryFundSources.invoke({})) as string;

    expect(result).toContain('Source A');
    expect(result).toContain('| Source A | 0 | 0 | 0 | - | - | - |');
  });

  it('preserves exact decimal totals above 2^53 without floating-point precision loss', async () => {
    getPortfolioMock.mockResolvedValue({
      funding_sources: [{ id: 'fs-mega', name: 'Mega Source' }],
      positions: [
        {
          id: 'pos-1',
          holder_source_of_fund_id: 'fs-mega',
          current_value: '9007199254740993.00',
        },
        {
          id: 'pos-2',
          holder_source_of_fund_id: 'fs-mega',
          current_value: '2.00',
        },
      ],
      entries: [
        {
          id: 'e1',
          position_id: 'pos-1',
          entry_type: 'buy',
          cash_delta: '-9007199254740993.00',
          is_reversal: false,
          allocations: [{ funding_source_id: 'fs-mega', amount: '9007199254740993.00' }],
        },
        {
          id: 'e2',
          position_id: 'pos-2',
          entry_type: 'buy',
          cash_delta: '-2.00',
          is_reversal: false,
          allocations: [{ funding_source_id: 'fs-mega', amount: '2.00' }],
        },
      ],
    });

    const result = (await queryFundSources.invoke({})) as string;

    // Exact sum must be 9,007,199,254,740,995 (ends in ...995, not ...994)
    expect(result).toContain('Mega Source');
    expect(result).toContain('9,007,199,254,740,995');
  });
});
