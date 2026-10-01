import { describe, it, expect } from 'vitest';
import {
  catalogItemsToCheck,
  compareCatalogToLedger,
  nanjingRowCheckInputs,
  submittedAssets,
  type FundLedgerTotals,
  type FundRowFigures,
} from './catalogLedgerCheck';
import type { FundCatalogItem, ParsedAsset, ParsedCommitmentEvent, ParsedTxn } from './types';

function item(overrides: Partial<FundCatalogItem> & { nameZh: string }): FundCatalogItem {
  return {
    filingCode: null,
    subscribedAmount: 100_000_000,
    paidInAmount: 60_000_000,
    investedAmount: 50_000_000,
    netCashFlowAmount: 10_000_000,
    ...overrides,
  };
}

const matching: FundLedgerTotals = {
  committed: 100_000_000,
  paidIn: 60_000_000,
  paidInCash: 60_000_000,
  invested: 50_000_000,
  cash: 10_000_000,
};

const matchingRows: FundRowFigures = {
  committed: 100_000_000,
  paidIn: 60_000_000,
  invested: 50_000_000,
};

const rowsFor = (figures: FundRowFigures) => ({ rowFigures: new Map([['基金甲', figures]]) });

describe('compareCatalogToLedger', () => {
  it('reports no differences when the ledger matches both the rows and the catalog', () => {
    const result = compareCatalogToLedger(
      [item({ nameZh: '基金甲' })],
      new Map([['基金甲', matching]]),
      rowsFor(matchingRows),
    );
    expect(result).toEqual({
      checked_funds: 1,
      differences: [],
      skipped_funds: [],
      missing_funds: [],
      warnings: [],
      notes: [],
    });
  });

  it('flags the MB-569 double post as posting differences on paid-in and cash', () => {
    // The receiving fund's rows say 47M paid-in and 1M net cash; a second 29M
    // paid-in written on an investor-held position doubles both.
    const result = compareCatalogToLedger(
      [item({ nameZh: '基金甲', subscribedAmount: 250_000_000, paidInAmount: 47_000_000, investedAmount: 46_000_000, netCashFlowAmount: 1_000_000 })],
      new Map([['基金甲', { committed: 250_000_000, paidIn: 76_000_000, paidInCash: 76_000_000, invested: 46_000_000, cash: 30_000_000 }]]),
      rowsFor({ committed: 250_000_000, paidIn: 47_000_000, invested: 46_000_000 }),
    );

    expect(result.differences).toEqual([
      { fund: '基金甲', metric: 'paid_in', kind: 'posting', ledgerValue: 76_000_000, rowsValue: 47_000_000, catalogValue: 47_000_000, diff: 29_000_000 },
      { fund: '基金甲', metric: 'cash', kind: 'posting', ledgerValue: 30_000_000, rowsValue: 1_000_000, catalogValue: 1_000_000, diff: 29_000_000 },
    ]);
    expect(result.warnings).toEqual([
      '基金甲: ledger paid-in CNY 76,000,000 vs rows CNY 47,000,000 (diff +29,000,000; 基金汇总 CNY 47,000,000).',
      '基金甲: ledger cash CNY 30,000,000 vs rows CNY 1,000,000 (diff +29,000,000).',
    ]);
    expect(result.notes).toEqual([]);
  });

  it('notes a difference review already flagged when the ledger matches the rows but not the catalog', () => {
    // Rows net of a synthetic transfer-out: the import and the ledger agree, the summary does not.
    const result = compareCatalogToLedger(
      [item({ nameZh: '基金甲' })],
      new Map([['基金甲', { ...matching, committed: 96_912_385.48 }]]),
      rowsFor({ ...matchingRows, committed: 96_912_385.48 }),
    );

    expect(result.differences).toEqual([
      {
        fund: '基金甲',
        metric: 'commitment',
        kind: 'review',
        ledgerValue: 96_912_385.48,
        rowsValue: 96_912_385.48,
        catalogValue: 100_000_000,
        diff: expect.closeTo(-3_087_614.52, 2),
      },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.notes).toEqual([
      "基金甲: ledger commitments CNY 96,912,385.48 vs 基金汇总 CNY 100,000,000 (diff -3,087,614.52); already flagged in review, and the ledger matches the import's rows.",
    ]);
  });

  it('compares cash paid-in with the rows so an approved write-off is not a posting difference', () => {
    // 实缴 rows are cash; the write-off posts only when the reviewer resolves it.
    const result = compareCatalogToLedger(
      [item({ nameZh: '基金甲' })],
      new Map([['基金甲', { ...matching, paidIn: 59_085_218.63, paidInCash: 60_000_000 }]]),
      rowsFor(matchingRows),
    );
    expect(result.differences).toEqual([]);
  });

  it('skips a partially imported fund as not checked instead of reporting false mismatches', () => {
    const result = compareCatalogToLedger(
      [item({ nameZh: '基金甲' }), item({ nameZh: '基金乙' })],
      new Map([
        ['基金甲', { ...matching, committed: 1, paidIn: 1, paidInCash: 1, invested: 1, cash: 1 }],
        ['基金乙', matching],
      ]),
      { rowFigures: new Map([['基金乙', matchingRows]]), partialFunds: new Set(['基金甲']) },
    );

    expect(result.checked_funds).toBe(1);
    expect(result.skipped_funds).toEqual(['基金甲']);
    expect(result.differences).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.notes).toEqual(['基金甲: not checked (partial import — not all of its rows were selected).']);
  });

  it('falls back to comparing the ledger with the catalog when no row figures are given', () => {
    const result = compareCatalogToLedger(
      [item({ nameZh: '基金甲' })],
      new Map([['基金甲', { ...matching, committed: 91_000_000, paidIn: 59_000_000, paidInCash: 60_000_000 }]]),
    );
    expect(result.differences).toEqual([
      { fund: '基金甲', metric: 'commitment', kind: 'posting', ledgerValue: 91_000_000, rowsValue: null, catalogValue: 100_000_000, diff: -9_000_000 },
      { fund: '基金甲', metric: 'paid_in', kind: 'posting', ledgerValue: 59_000_000, rowsValue: null, catalogValue: 60_000_000, diff: -1_000_000 },
    ]);
    expect(result.warnings[0]).toBe(
      '基金甲: ledger commitments CNY 91,000,000 vs 基金汇总 CNY 100,000,000 (diff -9,000,000).',
    );
  });

  it('ignores sub-yuan rounding from the 万元 → CNY conversion', () => {
    const result = compareCatalogToLedger(
      [item({ nameZh: '基金甲', subscribedAmount: 10836.4561 * 10_000 })],
      new Map([['基金甲', { ...matching, committed: 108_364_561 }]]),
      rowsFor({ ...matchingRows, committed: 108_364_561.45 }),
    );
    expect(result.differences).toEqual([]);
  });

  it('skips cash when the proposal predates the net cash-flow figure', () => {
    const result = compareCatalogToLedger(
      [item({ nameZh: '基金甲', netCashFlowAmount: undefined })],
      new Map([['基金甲', { ...matching, cash: 2 }]]),
      rowsFor(matchingRows),
    );
    expect(result.differences).toEqual([]);
  });

  it('warns about a catalog fund that has no fund in the ledger', () => {
    const result = compareCatalogToLedger([item({ nameZh: '基金乙' })], new Map());
    expect(result.checked_funds).toBe(0);
    expect(result.missing_funds).toEqual(['基金乙']);
    expect(result.warnings).toEqual(['基金乙: listed in 基金汇总 but no fund was recorded in the ledger.']);
  });

  it('notes a catalog fund with no rows and no ledger fund instead of warning that it is missing', () => {
    const result = compareCatalogToLedger(
      [item({ nameZh: '基金乙' }), item({ nameZh: '基金丙' })],
      new Map(),
      { fundsWithRows: new Set(['基金丙']) },
    );
    expect(result.missing_funds).toEqual(['基金丙']);
    expect(result.warnings).toEqual(['基金丙: listed in 基金汇总 but no fund was recorded in the ledger.']);
    expect(result.notes).toEqual(['基金乙: not checked (no rows in this workbook and no fund in the ledger).']);
  });

  it('matches ledger totals and row figures by canonical name (full-width parentheses)', () => {
    const result = compareCatalogToLedger(
      [item({ nameZh: '基金甲（有限合伙）' })],
      new Map([['基金甲(有限合伙)', matching]]),
      { rowFigures: new Map([['基金甲(有限合伙)', matchingRows]]) },
    );
    expect(result.checked_funds).toBe(1);
    expect(result.missing_funds).toEqual([]);
    expect(result.differences).toEqual([]);
  });

  it('does not check ledger-only funds that the summary states no figures for', () => {
    const result = compareCatalogToLedger(
      [item({ nameZh: '基金丙', subscribedAmount: null, paidInAmount: null, investedAmount: null })],
      new Map(),
    );
    expect(result.checked_funds).toBe(0);
    expect(result.warnings).toEqual([]);
  });
});

describe('catalogItemsToCheck', () => {
  it('returns [] for a missing catalog', () => {
    expect(catalogItemsToCheck(undefined)).toEqual([]);
  });

  it('keeps only catalog funds with at least one stated figure', () => {
    const stated = item({ nameZh: '基金甲', subscribedAmount: null, paidInAmount: 0, investedAmount: null });
    const empty = item({ nameZh: '基金丙', subscribedAmount: null, paidInAmount: null, investedAmount: null });
    expect(catalogItemsToCheck([stated, empty])).toEqual([stated]);
  });
});

function txn(sourceRow: number, valueAmount: number): ParsedTxn {
  return {
    date: '2024-01-01',
    type: 'contribution',
    subTypeLabel: null,
    pricePerShare: null,
    shareCount: null,
    valueAmount,
    fxRate: null,
    notes: null,
    sourceRow,
  } as ParsedTxn;
}

function asset(code: string, fund: string, txns: ParsedTxn[]): ParsedAsset {
  return { code, name: code, fund, assetType: 'direct_investment', txns, valuations: [] } as unknown as ParsedAsset;
}

function event(sourceRow: number, fund: string, intent: ParsedCommitmentEvent['intent'], amount: number): ParsedCommitmentEvent {
  return {
    fund,
    investorName: 'LP',
    investorTypeRaw: null,
    investorTypeLabel: null,
    date: '2024-01-01',
    intent,
    amount,
    currency: 'CNY',
    counterpartyName: null,
    actionRaw: '',
    natureRaw: null,
    directionRaw: '',
    notes: null,
    sourceRow,
  } as ParsedCommitmentEvent;
}

describe('submittedAssets', () => {
  it('keeps selected codes only, restricted to the txns a selection names', () => {
    const a = asset('A', '基金甲', [txn(10, 1), txn(11, 2)]);
    const b = asset('B', '基金甲', [txn(12, 3)]);
    const c = asset('C', '基金乙', [txn(13, 4)]);

    const result = submittedAssets([a, b, c], ['A', 'B'], [{ asset_code: 'A', txns: [txn(11, 5)] }, { asset_code: 'B' }]);

    expect(result.map((x) => x.code)).toEqual(['A', 'B']);
    expect(result[0].txns).toEqual([txn(11, 5)]);
    expect(result[1]).toBe(b);
  });

  it("drops txns the approval does not post and restores a contribution's positive amount", () => {
    const a = asset('A', '基金甲', [txn(10, 30), txn(11, 20)]);
    const result = submittedAssets([a], ['A'], [
      { asset_code: 'A', txns: [{ ...txn(10, -30) }, { ...txn(11, -20), allowPost: false }] },
    ]);
    expect(result[0].txns).toEqual([txn(10, 30)]);
  });
});

describe('nanjingRowCheckInputs', () => {
  const catalogItems = [item({ nameZh: '基金甲' }), item({ nameZh: '基金乙' })];
  const assets = [asset('A', '基金甲', [txn(10, 30_000_000), txn(11, 20_000_000)]), asset('B', '基金乙', [txn(12, 5_000_000)])];
  const events = [
    event(1, '基金甲', 'increase', 100_000_000),
    event(2, '基金甲', 'paid_in', 60_000_000),
    event(3, '基金乙', 'increase', 8_000_000),
    event(4, '基金乙', 'decrease', 1_000_000),
  ];

  it("totals each fund's submitted rows with the parse-time reconciliation's sums", () => {
    const { rowFigures, partialFunds } = nanjingRowCheckInputs({
      catalogItems,
      proposalAssets: assets,
      proposalEvents: events,
      submittedAssets: assets,
      submittedEvents: events,
    });

    expect(rowFigures.get('基金甲')).toEqual({ committed: 100_000_000, paidIn: 60_000_000, invested: 50_000_000 });
    expect(rowFigures.get('基金乙')).toEqual({ committed: 7_000_000, paidIn: 0, invested: 5_000_000 });
    expect(partialFunds).toEqual(new Set());
  });

  it('lists the funds that have any row in the workbook, submitted or not', () => {
    const { fundsWithRows } = nanjingRowCheckInputs({
      catalogItems: [...catalogItems, item({ nameZh: '基金丙' })],
      proposalAssets: assets,
      proposalEvents: events,
      submittedAssets: [],
      submittedEvents: [],
    });
    expect(fundsWithRows).toEqual(new Set(['基金甲', '基金乙']));
  });

  it('marks a fund partial when one of its asset txns or commitment events was not submitted', () => {
    const { partialFunds } = nanjingRowCheckInputs({
      catalogItems,
      proposalAssets: assets,
      proposalEvents: events,
      submittedAssets: [asset('A', '基金甲', [txn(10, 30_000_000)]), assets[1]],
      submittedEvents: events.filter((e) => e.sourceRow !== 4),
    });
    expect(partialFunds).toEqual(new Set(['基金甲', '基金乙']));
  });

  it("uses a reviewer's edited amount as the expected figure, not the parsed one", () => {
    const { rowFigures, partialFunds } = nanjingRowCheckInputs({
      catalogItems,
      proposalAssets: assets,
      proposalEvents: events,
      submittedAssets: [asset('A', '基金甲', [txn(10, 30_000_000), txn(11, 25_000_000)]), assets[1]],
      submittedEvents: events,
    });
    expect(rowFigures.get('基金甲')?.invested).toBe(55_000_000);
    expect(partialFunds).toEqual(new Set());
  });

  it('gives a catalog fund with no rows zero figures rather than leaving it unchecked', () => {
    const { rowFigures } = nanjingRowCheckInputs({
      catalogItems: [...catalogItems, item({ nameZh: '基金丙' })],
      proposalAssets: assets,
      proposalEvents: events,
      submittedAssets: assets,
      submittedEvents: events,
    });
    expect(rowFigures.get('基金丙')).toEqual({ committed: 0, paidIn: 0, invested: 0 });
  });
});
