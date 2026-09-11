import { afterEach, describe, expect, it, vi } from 'vitest';

const getPortfolioMock = vi.fn();
const getDefaultCurrencyMock = vi.fn(async () => 'USD');

vi.mock('@/lib/server/db', () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: vi.fn(async () => 'ws-1'),
}));

vi.mock('@/lib/services', () => ({
  createContainer: vi.fn(() => ({
    flPortfolioService: { getPortfolio: getPortfolioMock },
    workspaceService: { getDefaultCurrency: getDefaultCurrencyMock },
  })),
}));

import { ENTRIES, buildTestPortfolio } from '@/lib/fundLedger/testFixtures';
import { queryLedgerEntries } from './query_ledger_entries';

afterEach(() => {
  vi.clearAllMocks();
  getDefaultCurrencyMock.mockResolvedValue('USD');
});

describe('queryLedgerEntries', () => {
  it('returns an empty-state message when nothing has been posted', async () => {
    getPortfolioMock.mockResolvedValue(buildTestPortfolio({ entries: [] }));

    const result = (await queryLedgerEntries.invoke({})) as string;

    expect(result).toContain('No ledger entries have been posted');
  });

  it('lists every row with its signed deltas, newest first', async () => {
    getPortfolioMock.mockResolvedValue(buildTestPortfolio());

    const result = (await queryLedgerEntries.invoke({})) as string;

    expect(result).toContain('**12 ledger entries**');
    expect(result).toContain('| Date | From | To | Type |');
    // The most recent row is the fee reversal, dated 2026-04-02.
    const rows = result.split('\n').filter((line) => line.startsWith('| 0') || line.startsWith('| 1') || line.startsWith('| 2') || line.startsWith('| 3'));
    expect(rows[0]).toContain('02/04/26');
    expect(result).toContain('-43780000.00');
  });

  it("labels the totals with the workspace display currency's symbol", async () => {
    getPortfolioMock.mockResolvedValue(buildTestPortfolio());
    getDefaultCurrencyMock.mockResolvedValue('CNY');

    const result = (await queryLedgerEntries.invoke({})) as string;

    // Same relabel the Ledger page applies, so a figure quoted in chat matches
    // the one in the table.
    expect(result).toContain('Cash out RMB ');
    expect(result).not.toContain('Cash out $');
  });

  it('reads From and To from the holder point of view', async () => {
    getPortfolioMock.mockResolvedValue(buildTestPortfolio());

    const result = (await queryLedgerEntries.invoke({ entry_type: 'buy' })) as string;

    // Money leaves the holder, so the holder is on the left.
    expect(result).toMatch(/\| Meranti Global Investment Ltd \| GOTO Group \| Buy \|/);
  });

  it('reports commitment from inception even when the listed range is narrowed', async () => {
    getPortfolioMock.mockResolvedValue(buildTestPortfolio());

    const result = (await queryLedgerEntries.invoke({ from_date: '2025-01-01' })) as string;

    // The only commitment row predates 2025, and must still be counted.
    expect(result).toContain('Commitment $50M');
    expect(result).toContain('from 2025-01-01');
  });

  it('defaults the as-of date to today, so future-dated rows are not counted', async () => {
    const portfolio = buildTestPortfolio();
    // A row posted for a date that has not arrived yet. The page's date picker
    // caps at today, so the copilot must not report totals that include it.
    portfolio.entries = [
      ...portfolio.entries,
      { ...ENTRIES.distribution, id: 'le-future', entry_date: '2099-01-01' },
    ];
    getPortfolioMock.mockResolvedValue(portfolio);

    const result = (await queryLedgerEntries.invoke({})) as string;

    expect(result).toContain('**12 ledger entries**');
    expect(result).not.toContain('01/01/99');
  });

  it('stops counting entirely at the as-of date', async () => {
    getPortfolioMock.mockResolvedValue(buildTestPortfolio());

    const result = (await queryLedgerEntries.invoke({ as_of_date: '2018-06-30' })) as string;

    expect(result).toContain('**2 ledger entries**');
    expect(result).toContain('as of 2018-06-30');
    expect(result).not.toContain('Akulaku');
  });

  it('resolves an entity name fuzzily and keeps every row touching it', async () => {
    getPortfolioMock.mockResolvedValue(buildTestPortfolio());

    const result = (await queryLedgerEntries.invoke({ entity: 'akulak' })) as string;

    expect(result).toContain('Matched "akulak" to **Akulaku**');
    // The buy and the write-off both sit on the Akulaku position.
    expect(result).toContain('**2 ledger entries**');
  });

  it('finds rows through a funding split, not just the position', async () => {
    getPortfolioMock.mockResolvedValue(buildTestPortfolio());

    const result = (await queryLedgerEntries.invoke({ entity: 'Aldiracita' })) as string;

    // Aldiracita is named only in the Akulaku entry's allocation split.
    expect(result).toContain('**1 ledger entry**');
    expect(result).toContain('Akulaku');
  });

  it('finds the far leg of a transfer', async () => {
    getPortfolioMock.mockResolvedValue(buildTestPortfolio());

    const result = (await queryLedgerEntries.invoke({ entity: 'Co-invest Partners' })) as string;

    // One leg is held by Co-invest; the other names it as counterparty.
    expect(result).toContain('**2 ledger entries**');
  });

  it('says so when a name matches nothing, and points at search_investments', async () => {
    getPortfolioMock.mockResolvedValue(buildTestPortfolio());

    const result = (await queryLedgerEntries.invoke({ entity: 'Nonexistent Holdings' })) as string;

    expect(result).toContain('Nothing in the ledger matches');
    expect(result).toContain('search_investments');
  });

  it('filters by entry type and tolerates spacing in the value', async () => {
    getPortfolioMock.mockResolvedValue(buildTestPortfolio());

    const result = (await queryLedgerEntries.invoke({
      entry_type: 'commitment transfer',
    })) as string;

    expect(result).toContain('**2 ledger entries**');
    expect(result).toContain('type commitment_transfer');
  });

  it('rejects an entry type that is not in the schema, listing the valid ones', async () => {
    getPortfolioMock.mockResolvedValue(buildTestPortfolio());

    const result = (await queryLedgerEntries.invoke({ entry_type: 'dividend' })) as string;

    expect(result).toContain('Unknown entry_type "dividend"');
    expect(result).toContain('commitment, commitment_transfer');
  });

  it('narrows to the rows that still need checking', async () => {
    getPortfolioMock.mockResolvedValue(buildTestPortfolio());

    const result = (await queryLedgerEntries.invoke({ needs_checking_only: true })) as string;

    expect(result).toContain('**1 ledger entry**');
    expect(result).toContain('needs checking');
  });

  it("appends a position's balances when one is named", async () => {
    getPortfolioMock.mockResolvedValue(buildTestPortfolio());

    const result = (await queryLedgerEntries.invoke({ position_id: 'pos-mer-aku' })) as string;

    expect(result).toContain('Meranti Global Investment Ltd · Akulaku');
    expect(result).toContain('Units held 1880000');
    // $6.63M over 2.21M shares.
    expect(result).toContain('blended 3.0000 per unit');
  });

  it('caps the table but keeps the totals over every matching row', async () => {
    getPortfolioMock.mockResolvedValue(buildTestPortfolio());

    const result = (await queryLedgerEntries.invoke({ limit: 2 })) as string;

    expect(result).toContain('**12 ledger entries**');
    expect(result).toContain('Showing the 2 most recent of 12 matching rows');
  });

  it('clamps a limit above the maximum rather than dumping the whole ledger', async () => {
    getPortfolioMock.mockResolvedValue(buildTestPortfolio());

    const result = (await queryLedgerEntries.invoke({ limit: 100000 })) as string;

    // 12 rows all fit, so no truncation notice — the clamp must not error.
    expect(result).not.toContain('Showing the');
  });

  it('reports no matches without pretending the ledger is empty', async () => {
    getPortfolioMock.mockResolvedValue(buildTestPortfolio());

    const result = (await queryLedgerEntries.invoke({
      entry_type: 'sell',
    })) as string;

    expect(result).toContain('No rows match those filters');
    expect(result).not.toContain('No ledger entries have been posted');
  });

  it('explains the sign convention so the numbers are not misread', async () => {
    getPortfolioMock.mockResolvedValue(buildTestPortfolio());

    const result = (await queryLedgerEntries.invoke({})) as string;

    expect(result).toContain('negative cash means they paid');
  });

  it('surfaces a load failure instead of throwing at the agent', async () => {
    getPortfolioMock.mockRejectedValue(new Error('connection refused'));

    const result = (await queryLedgerEntries.invoke({})) as string;

    expect(result).toContain('Failed to read the ledger: connection refused');
  });
});
