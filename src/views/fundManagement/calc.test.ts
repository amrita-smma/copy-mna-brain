import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  aggregateByTxn,
  buildInvestorGroupLookup,
  calculateXirr,
  canSubmitTxnDialog,
  computeFoF,
  computeInv,
  effectiveTransactions,
  entityToFundAdapter,
  formatHolderCounts,
  formatHolderName,
  getAssetDisplayName,
  getAssetEntity,
  getNextSellProceedsDestination,
  growth,
  holdingBreakdown,
  holdingsPortfolioTotals,
  mergeHoldingsAcrossFunds,
  normalizeEntityName,
  portfolioTotals,
  proceedsTreatmentLabel,
  proceedsTreatmentOptionsFor,
  QLABELS,
  recomputeFund,
  resolveInvestorGroupName,
  scopeHoldingToFund,
  selectEligibleMark,
  signedOtherCashDelta,
  isEstimatedTxn,
  isAdjustmentTxn,
  sliceHoldingsByTxn,
  splitHoldingByTxn,
  sumHist,
  sumSlices,
  txnTypeLabel,
} from './calc';
import { DeltaBadge } from './parts';
import { MetricCards } from './MetricCards';
import { MoneyBreakdown } from './MoneyBreakdown';
import { FoFDetail, HoldingDetail, QuarterTable } from './HoldingDetail';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { Fund, Holding, Inv, Investor, Quarter } from './types';

function makeInvestor(
  id: string,
  holdings: Holding[] = [],
  groupName: string | null = null,
  n?: string,
  overrides: Partial<Investor> = {},
): Investor {
  return {
    id,
    n: n ?? `Investor ${id}`,
    type: 'Corporate',
    stakes: {},
    groupName,
    holdings,
    valuationCoverage: holdings.some(
      (h) => h.fmv === null || h.valuationCoverage === 'partial',
    )
      ? 'partial'
      : 'complete',
    ...overrides,
  };
}

function makeHolding(overrides: {
  id?: string;
  cost?: number;
  fmv?: number | null;
  real?: number;
  txns?: Inv['txns'];
  fundId?: string | null;
  tp?: Holding['tp'];
} = {}): Holding {
  const txns: Inv['txns'] = overrides.txns ?? [];
  return {
    id: overrides.id,
    n: 'Test Asset',
    tp: overrides.tp ?? 'Equity',
    dt: '2024-01-01',
    cost: overrides.cost ?? 100,
    fmv: overrides.fmv !== undefined ? overrides.fmv : 120,
    real: overrides.real ?? 0,
    moic: 1.2,
    st: 'Active',
    inv: {
      txns,
      quarterly: [],
    },
  };
}

function makeFund(id: string, holdings: Holding[]): Fund {
  return {
    id,
    n: `Fund ${id}`,
    v: 2024,
    size: 1000,
    called: 0,
    calledPct: 0,
    fmv: 0,
    real: 0,
    dpi: 0,
    tvpi: 0,
    irr: 0,
    st: 'Investing',
    h: holdings,
  };
}

describe('effectiveTransactions', () => {
  it('keeps only the active replacement from original + reversal + replacement', () => {
    const active = effectiveTransactions([
      { id: 'original', date: '2026-01-01', type: 'Buy', value: 10, isReversedOriginal: true },
      { id: 'reversal', date: '2026-02-01', type: 'Buy', value: -10, isReversal: true },
      { id: 'replacement', date: '2026-02-01', type: 'Buy', value: 12 },
    ]);
    expect(active.map((txn) => txn.id)).toEqual(['replacement']);
    expect(active.reduce((sum, txn) => sum + (txn.value ?? 0), 0)).toBe(12);
  });

  it('preserves original transaction before reversal date and excludes on or after reversal date', () => {
    const txns = [
      { id: 'original', date: '2026-01-15', type: 'Buy' as const, value: 10, isReversedOriginal: true, reversalDate: '2026-05-20' },
      { id: 'reversal', date: '2026-05-20', type: 'Buy' as const, value: -10, isReversal: true },
    ];

    const before = effectiveTransactions(txns, '2026-03-31');
    expect(before.map((t) => t.id)).toEqual(['original']);
    expect(before[0].value).toBe(10);

    const onReversal = effectiveTransactions(txns, '2026-05-20');
    expect(onReversal).toEqual([]);

    const afterReversal = effectiveTransactions(txns, '2026-06-30');
    expect(afterReversal).toEqual([]);

    const current = effectiveTransactions(txns);
    expect(current).toEqual([]);
  });
});

describe('getAssetDisplayName', () => {
  it('appends the english name in brackets when the asset has one', () => {
    const h = makeHolding();
    h.n = '株式会社アクメ';
    h.englishName = 'Acme Robotics';
    expect(getAssetDisplayName(h)).toBe('株式会社アクメ (Acme Robotics)');
  });

  it('returns the name unchanged when there is no english name', () => {
    expect(getAssetDisplayName(makeHolding())).toBe('Test Asset');
  });

  it('does not repeat the name when the english name is the same', () => {
    const h = makeHolding();
    h.englishName = ' Test Asset ';
    expect(getAssetDisplayName(h)).toBe('Test Asset');
  });

  it('ignores a whitespace-only english name', () => {
    const h = makeHolding();
    h.englishName = '   ';
    expect(getAssetDisplayName(h)).toBe('Test Asset');
  });
});

describe('scopeHoldingToFund', () => {
  it('returns the holding unchanged when all transactions belong to the given fund', () => {
    const h = makeHolding({
      cost: 50,
      txns: [
        { date: '2024-01-01', type: 'Buy', value: 50, fundId: 'f1' },
      ],
    });
    const scoped = scopeHoldingToFund(h, 'f1');
    expect(scoped.cost).toBe(50);
    expect(scoped).toBe(h); // same reference — no copy made
  });

  it('returns the holding unchanged when there are no transactions', () => {
    const h = makeHolding({ cost: 80, txns: [] });
    const scoped = scopeHoldingToFund(h, 'f1');
    expect(scoped.cost).toBe(80);
    expect(scoped).toBe(h);
  });

  it('scales cost proportionally for a co-invested asset split across two funds', () => {
    const h = makeHolding({
      cost: 80, // 80M total: 50M from f1, 30M from f2
      fmv: 100,
      real: 0,
      txns: [
        { date: '2024-01-01', type: 'Buy', value: 50, fundId: 'f1' },
        { date: '2024-02-01', type: 'Buy', value: 30, fundId: 'f2' },
      ],
    });

    const scopedF1 = scopeHoldingToFund(h, 'f1');
    expect(scopedF1.cost).toBeCloseTo(50); // 80 * (50/80)
    expect(scopedF1.fmv).toBeCloseTo(62.5); // 100 * (50/80)

    const scopedF2 = scopeHoldingToFund(h, 'f2');
    expect(scopedF2.cost).toBeCloseTo(30); // 80 * (30/80)

    // Scoped costs sum back to total
    expect(scopedF1.cost + scopedF2.cost).toBeCloseTo(80);
  });

  it('correctly attributes null-fund transactions to the "unassigned" pseudo-fund', () => {
    // This is the regression case: before the fix, all null-fund transactions
    // were invisible to scopeHoldingToFund('unassigned'), zeroing out the asset.
    const h = makeHolding({
      cost: 100,
      fmv: 120,
      real: 10,
      txns: [
        { date: '2024-01-01', type: 'Buy', value: 100, fundId: null },
        { date: '2024-06-01', type: 'Sell', value: 10, fundId: null, sellProceedsDestination: 'distributed_to_investor' },
      ],
    });

    const scoped = scopeHoldingToFund(h, 'unassigned');
    // All transactions belong to the unassigned fund → no split needed → same ref
    expect(scoped).toBe(h);
    expect(scoped.cost).toBe(100);
    expect(scoped.fmv).toBe(120);
    expect(scoped.real).toBe(10);
  });

  it('splits correctly when an asset has both null-fund and real-fund transactions', () => {
    // 60M via null-fund (unassigned), 40M via fund A
    const h = makeHolding({
      cost: 100,
      fmv: 150,
      real: 0,
      txns: [
        { date: '2024-01-01', type: 'Buy', value: 60, fundId: null },
        { date: '2024-03-01', type: 'Buy', value: 40, fundId: 'f1' },
      ],
    });

    const scopedUnassigned = scopeHoldingToFund(h, 'unassigned');
    expect(scopedUnassigned.cost).toBeCloseTo(60); // 100 * (60/100)
    expect(scopedUnassigned.fmv).toBeCloseTo(90);  // 150 * (60/100)

    const scopedF1 = scopeHoldingToFund(h, 'f1');
    expect(scopedF1.cost).toBeCloseTo(40); // 100 * (40/100)

    // Both slices sum back to total
    expect(scopedUnassigned.cost + scopedF1.cost).toBeCloseTo(100);
  });

  it('does not zero out _investedCapitalAmount for unassigned assets', () => {
    const h = makeHolding({
      cost: 100,
      txns: [
        { date: '2024-01-01', type: 'Buy', value: 100, fundId: null },
      ],
    });
    h.inv!._investedCapitalAmount = 100_000_000; // 100M raw dollars

    const scoped = scopeHoldingToFund(h, 'unassigned');
    expect(scoped).toBe(h); // all txns match unassigned → unchanged
    expect(scoped.inv!._investedCapitalAmount).toBe(100_000_000);
  });
});

describe('mergeHoldingsAcrossFunds', () => {
  it('passes a single-fund holding through untouched (same reference)', () => {
    const h = makeHolding({ id: 'a1', cost: 50 });
    const rows = mergeHoldingsAcrossFunds([makeFund('f1', [h])]);
    expect(rows).toHaveLength(1);
    expect(rows[0].h).toBe(h);
    expect(rows[0].key).toBe('a1');
    expect(rows[0].funds.map((f) => f.id)).toEqual(['f1']);
  });

  it('merges a co-invested asset back into one whole-asset row', () => {
    // One holding whose ledger names two funds: each fund's copy is
    // scoped to its share, and the Asset tab must show one row with the totals.
    const whole = makeHolding({
      id: 'a1',
      cost: 80,
      fmv: 100,
      real: 20,
      txns: [
        { date: '2024-01-01', type: 'Buy', value: 50, fundId: 'f1' },
        { date: '2024-02-01', type: 'Buy', value: 30, fundId: 'f2' },
        { date: '2024-03-01', type: 'Sell', value: 20, fundId: 'f1', sellProceedsDestination: 'distributed_to_investor' },
      ],
    });
    const copyF1 = scopeHoldingToFund(whole, 'f1');
    const copyF2 = scopeHoldingToFund(whole, 'f2');

    const rows = mergeHoldingsAcrossFunds([makeFund('f1', [copyF1]), makeFund('f2', [copyF2])]);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.key).toBe('a1');
    expect(row.h.cost).toBeCloseTo(80);
    expect(row.h.fmv).toBeCloseTo(100);
    expect(row.h.real).toBeCloseTo(20);
    expect(row.h.moic).toBeCloseTo(1.5); // (100 + 20) / 80
    // Full ledger restored, in date order.
    expect(row.h.inv!.txns.map((t) => t.fundId)).toEqual(['f1', 'f2', 'f1']);
    // Primary fund (largest invested share) listed first.
    expect(row.funds.map((f) => f.id)).toEqual(['f1', 'f2']);
  });

  it('re-sums the scaled stored override amounts across copies', () => {
    const whole = makeHolding({
      id: 'a1',
      cost: 100,
      txns: [
        { date: '2024-01-01', type: 'Buy', value: 60, fundId: 'f1' },
        { date: '2024-02-01', type: 'Buy', value: 40, fundId: 'f2' },
      ],
    });
    whole.inv!._investedCapitalAmount = 100_000_000;
    const copyF1 = scopeHoldingToFund(whole, 'f1');
    const copyF2 = scopeHoldingToFund(whole, 'f2');

    const rows = mergeHoldingsAcrossFunds([makeFund('f1', [copyF1]), makeFund('f2', [copyF2])]);
    expect(rows[0].h.inv!._investedCapitalAmount).toBeCloseTo(100_000_000);
  });

  it('keeps distinct assets separate even when their names match', () => {
    const h1 = makeHolding({ id: 'a1', cost: 10 });
    const h2 = makeHolding({ id: 'a2', cost: 20 });
    const rows = mergeHoldingsAcrossFunds([makeFund('f1', [h1]), makeFund('f2', [h2])]);
    expect(rows).toHaveLength(2);
  });

  it('never merges holdings without a server id', () => {
    const h1 = makeHolding({ cost: 10 });
    const h2 = makeHolding({ cost: 20 });
    const rows = mergeHoldingsAcrossFunds([makeFund('f1', [h1, h2])]);
    expect(rows).toHaveLength(2);
    expect(rows[0].h).toBe(h1);
    expect(rows[1].h).toBe(h2);
  });
});

describe('holdingsPortfolioTotals', () => {
  it('includes invested capital from assets in the unassigned pseudo-fund', () => {
    const unassignedAsset = makeHolding({
      cost: 50,
      fmv: 60,
      real: 5,
      txns: [
        { date: '2024-01-01', type: 'Buy', value: 50, fundId: null },
      ],
    });
    const realAsset = makeHolding({
      cost: 100,
      fmv: 120,
      real: 0,
      txns: [
        { date: '2024-01-01', type: 'Buy', value: 100, fundId: 'f1' },
      ],
    });

    const fundF1 = makeFund('f1', [realAsset]);
    const unassignedFund = makeFund('unassigned', [unassignedAsset]);

    const totals = holdingsPortfolioTotals([fundF1, unassignedFund]);
    expect(totals.invested).toBe(150); // 100 + 50, NOT 100 (which would be the bug)
    expect(totals.fmv).toBe(180); // 120 + 60
    expect(totals.real).toBe(5);
  });

  it('correctly handles a portfolio with only unassigned assets', () => {
    const h1 = makeHolding({
      cost: 40, fmv: 50, real: 0,
      txns: [{ date: '2024-01-01', type: 'Buy', value: 40, fundId: null }],
    });
    const h2 = makeHolding({
      cost: 60, fmv: 70, real: 10,
      txns: [{ date: '2024-01-01', type: 'Buy', value: 60, fundId: null }],
    });
    const unassigned = makeFund('unassigned', [h1, h2]);

    const totals = holdingsPortfolioTotals([unassigned]);
    expect(totals.invested).toBe(100);
    expect(totals.fmv).toBe(120);
    expect(totals.real).toBe(10);
  });
});

describe('proceedsTreatmentLabel', () => {
  it('formats cash_in_fund to Cash in fund', () => {
    expect(proceedsTreatmentLabel('cash_in_fund')).toBe('Cash in fund');
    expect(proceedsTreatmentLabel('cash_in_fund', 'Sell')).toBe('Cash in fund');
  });

  it('formats distributed_to_investor to Investor distribution', () => {
    expect(proceedsTreatmentLabel('distributed_to_investor')).toBe('Investor distribution');
    expect(proceedsTreatmentLabel('distributed_to_investor', 'Sell')).toBe('Investor distribution');
  });

  it('returns em dash for null or undefined destination on Sell', () => {
    expect(proceedsTreatmentLabel(null)).toBe('—');
    expect(proceedsTreatmentLabel(undefined)).toBe('—');
    expect(proceedsTreatmentLabel(null, 'Sell')).toBe('—');
    expect(proceedsTreatmentLabel(undefined, 'Sell')).toBe('—');
  });

  it('returns em dash for non-Sell transaction types regardless of destination value', () => {
    expect(proceedsTreatmentLabel('cash_in_fund', 'Buy')).toBe('—');
    expect(proceedsTreatmentLabel('distributed_to_investor', 'Buy')).toBe('—');
    expect(proceedsTreatmentLabel('cash_in_fund', 'Other')).toBe('—');
    expect(proceedsTreatmentLabel(null, 'Buy')).toBe('—');
  });
});

describe('proceedsTreatmentOptionsFor', () => {
  it('returns only distributed_to_investor for Cash holdings', () => {
    const options = proceedsTreatmentOptionsFor('Cash');
    expect(options).toEqual([
      { value: 'distributed_to_investor', label: 'Distribute to investor' },
    ]);
  });

  it('returns all options for Fund of funds and direct holdings', () => {
    expect(proceedsTreatmentOptionsFor('Fund of funds')).toEqual([
      { value: 'cash_in_fund', label: 'Convert to cash in fund' },
      { value: 'distributed_to_investor', label: 'Distribute to investor' },
    ]);
    expect(proceedsTreatmentOptionsFor('Direct Investments')).toEqual([
      { value: 'cash_in_fund', label: 'Convert to cash in fund' },
      { value: 'distributed_to_investor', label: 'Distribute to investor' },
    ]);
    expect(proceedsTreatmentOptionsFor('Equity')).toEqual([
      { value: 'cash_in_fund', label: 'Convert to cash in fund' },
      { value: 'distributed_to_investor', label: 'Distribute to investor' },
    ]);
  });
});

describe('canSubmitTxnDialog', () => {
  it('validates required fields for Buy transactions', () => {
    // Missing date
    expect(canSubmitTxnDialog({ date: '', value: '100', type: 'Buy' })).toBe(false);
    expect(canSubmitTxnDialog({ date: null, value: '100', type: 'Buy' })).toBe(false);

    // Missing value and PPS/shares
    expect(canSubmitTxnDialog({ date: '2024-01-01', value: '', type: 'Buy' })).toBe(false);

    // Valid with explicit value
    expect(canSubmitTxnDialog({ date: '2024-01-01', value: '100', type: 'Buy' })).toBe(true);

    // Valid with PPS and shares for non-FoF
    expect(
      canSubmitTxnDialog({
        date: '2024-01-01',
        pps: '10',
        shares: '5000',
        type: 'Buy',
        fof: false,
      }),
    ).toBe(true);
  });

  it('handles FoF Buy transactions without requiring PPS or shares or proceeds treatment', () => {
    expect(
      canSubmitTxnDialog({
        date: '2024-01-01',
        value: '500',
        type: 'Buy',
        fof: true,
      }),
    ).toBe(true);
  });

  it('requires proceeds treatment for direct asset Sell transactions', () => {
    // Sell without proceeds destination -> disallowed
    expect(
      canSubmitTxnDialog({
        date: '2024-01-01',
        value: '100',
        type: 'Sell',
        fof: false,
        sellProceedsDestination: '',
      }),
    ).toBe(false);

    expect(
      canSubmitTxnDialog({
        date: '2024-01-01',
        value: '100',
        type: 'Sell',
        fof: false,
        sellProceedsDestination: null,
      }),
    ).toBe(false);

    // Sell with invalid proceeds destination -> disallowed
    expect(
      canSubmitTxnDialog({
        date: '2024-01-01',
        value: '100',
        type: 'Sell',
        fof: false,
        sellProceedsDestination: 'invalid_destination',
      }),
    ).toBe(false);

    // Sell with cash_in_fund requires a concrete fund.
    expect(
      canSubmitTxnDialog({
        date: '2024-01-01',
        value: '100',
        type: 'Sell',
        fof: false,
        sellProceedsDestination: 'cash_in_fund',
        fundId: 'fund-1',
      }),
    ).toBe(true);

    // Sell with distributed_to_investor -> allowed
    expect(
      canSubmitTxnDialog({
        date: '2024-01-01',
        value: '100',
        type: 'Sell',
        fof: false,
        sellProceedsDestination: 'distributed_to_investor',
      }),
    ).toBe(true);

    // Sell with PPS and shares and valid destination -> allowed
    expect(
      canSubmitTxnDialog({
        date: '2024-01-01',
        pps: '20',
        shares: '1000',
        type: 'Sell',
        fof: false,
        sellProceedsDestination: 'cash_in_fund',
        fundId: 'fund-1',
      }),
    ).toBe(true);
  });

  it('requires proceeds treatment and handles fund requirements for FoF Sell transactions', () => {
    // FoF Sell without proceeds destination -> disallowed
    expect(
      canSubmitTxnDialog({
        date: '2024-01-01',
        value: '100',
        type: 'Sell',
        fof: true,
        sellProceedsDestination: '',
      }),
    ).toBe(false);

    expect(
      canSubmitTxnDialog({
        date: '2024-01-01',
        value: '100',
        type: 'Sell',
        fof: true,
        sellProceedsDestination: null,
      }),
    ).toBe(false);

    // FoF Sell with cash_in_fund requires a concrete fund
    expect(
      canSubmitTxnDialog({
        date: '2024-01-01',
        value: '100',
        type: 'Sell',
        fof: true,
        sellProceedsDestination: 'cash_in_fund',
        fundId: '',
      }),
    ).toBe(false);

    expect(
      canSubmitTxnDialog({
        date: '2024-01-01',
        value: '100',
        type: 'Sell',
        fof: true,
        sellProceedsDestination: 'cash_in_fund',
        fundId: 'unassigned',
      }),
    ).toBe(false);

    expect(
      canSubmitTxnDialog({
        date: '2024-01-01',
        value: '100',
        type: 'Sell',
        fof: true,
        sellProceedsDestination: 'cash_in_fund',
        fundId: 'fund-1',
      }),
    ).toBe(true);

    // FoF Sell with distributed_to_investor -> allowed
    expect(
      canSubmitTxnDialog({
        date: '2024-01-01',
        value: '100',
        type: 'Sell',
        fof: true,
        sellProceedsDestination: 'distributed_to_investor',
      }),
    ).toBe(true);
  });

  it('rejects cash_in_fund for Cash holding Sell transactions and accepts distributed_to_investor', () => {
    // Cash Sell with cash_in_fund -> disallowed
    expect(
      canSubmitTxnDialog({
        date: '2024-01-01',
        value: '100',
        type: 'Sell',
        isCash: true,
        sellProceedsDestination: 'cash_in_fund',
        fundId: 'fund-1',
      }),
    ).toBe(false);

    // Cash Sell with distributed_to_investor -> allowed
    expect(
      canSubmitTxnDialog({
        date: '2024-01-01',
        value: '100',
        type: 'Sell',
        isCash: true,
        sellProceedsDestination: 'distributed_to_investor',
      }),
    ).toBe(true);
  });
});

describe('getNextSellProceedsDestination', () => {
  it('preserves existing destination when switching to or staying on Sell', () => {
    expect(getNextSellProceedsDestination('Sell', 'cash_in_fund')).toBe('cash_in_fund');
    expect(getNextSellProceedsDestination('Sell', 'distributed_to_investor')).toBe(
      'distributed_to_investor',
    );
    expect(getNextSellProceedsDestination('Sell', '')).toBe('');
  });

  it('clears destination when switching away from Sell', () => {
    expect(getNextSellProceedsDestination('Buy', 'cash_in_fund')).toBe('');
    expect(getNextSellProceedsDestination('Other', 'distributed_to_investor')).toBe('');
    expect(getNextSellProceedsDestination('Other', 'cash_in_fund')).toBe('');
  });
});

describe('Phase 2 cash ledger calculations & labels', () => {
  it('txnTypeLabel renders Retained sale proceeds for generated internal transfers', () => {
    const cashHolding: Holding = {
      id: 'cash-1',
      n: 'Cash - USD',
      tp: 'Cash',
      dt: '2024-01-01',
      cost: 0,
      fmv: 100,
      real: 0,
      moic: 1,
      st: 'Active',
    };

    expect(
      txnTypeLabel(
        { type: 'Other', label: 'Retained sale proceeds', isGenerated: true },
        cashHolding,
      ),
    ).toBe('Retained sale proceeds');

    expect(
      txnTypeLabel(
        { type: 'Other', sourceDivestmentTxnId: 'sale-1' },
        cashHolding,
      ),
    ).toBe('Retained sale proceeds');
  });

  it('canSubmitTxnDialog requires a fund when sell proceeds destination is cash_in_fund', () => {
    // Missing fundId -> false
    expect(
      canSubmitTxnDialog({
        date: '2024-01-01',
        value: '100',
        type: 'Sell',
        fof: false,
        sellProceedsDestination: 'cash_in_fund',
        fundId: '',
      }),
    ).toBe(false);

    // Unassigned fundId -> false
    expect(
      canSubmitTxnDialog({
        date: '2024-01-01',
        value: '100',
        type: 'Sell',
        fof: false,
        sellProceedsDestination: 'cash_in_fund',
        fundId: 'unassigned',
      }),
    ).toBe(false);

    // Valid fundId -> true
    expect(
      canSubmitTxnDialog({
        date: '2024-01-01',
        value: '100',
        type: 'Sell',
        fof: false,
        sellProceedsDestination: 'cash_in_fund',
        fundId: 'fund-1',
      }),
    ).toBe(true);

    // distributed_to_investor does not require fundId
    expect(
      canSubmitTxnDialog({
        date: '2024-01-01',
        value: '100',
        type: 'Sell',
        fof: false,
        sellProceedsDestination: 'distributed_to_investor',
        fundId: 'unassigned',
      }),
    ).toBe(true);
  });

  it('computeFoF excludes generated internal_transfers from distributions and other income', () => {
    const cashHolding: Holding = {
      id: 'cash-1',
      n: 'Cash - USD',
      tp: 'Cash',
      dt: '2024-01-01',
      cost: 0.1,
      fmv: 0.6,
      real: 0,
      moic: 1,
      st: 'Active',
      inv: {
        txns: [
          { date: '2024-01-01', type: 'Buy', value: 0.1 }, // deposit
          {
            date: '2024-06-01',
            type: 'Other',
            value: 0.5,
            label: 'Retained sale proceeds',
            isGenerated: true,
            sourceDivestmentTxnId: 'sale-1',
          }, // retained sale proceeds
          {
            date: '2024-07-01',
            type: 'Sell',
            value: 0.02,
            sellProceedsDestination: 'distributed_to_investor',
          }, // distribution
        ],
        quarterly: [],
      },
    };

    const metrics = computeFoF(cashHolding)!;
    expect(metrics.totalCalled).toBe(0.1); // only Deposit (Buy)
    expect(metrics.totalOther).toBe(0); // internal_transfer excluded from other income
    expect(metrics.totalDist).toBe(0.02);
    expect(metrics.netDist).toBe(0.02); // 0.02, NOT 0.52
    expect(metrics.marketValue).toBe(0.6);
  });

  it('transaction-level grouping excludes generated cash inflows from realized value', () => {
    const cashHolding: Holding = {
      ...makeHolding({ fmv: 0.5 }),
      tp: 'Cash',
      inv: {
        txns: [
          {
            date: '2024-06-01',
            type: 'Other',
            value: 0.5,
            fundId: 'f1',
            isGenerated: true,
            sourceDivestmentTxnId: 'sale-1',
          },
          {
            date: '2024-07-01',
            type: 'Sell',
            value: 0.02,
            fundId: 'f1',
            sellProceedsDestination: 'distributed_to_investor',
          },
        ],
        quarterly: [],
      },
    };
    const fund = makeFund('f1', [cashHolding]);

    const grouped = splitHoldingByTxn(cashHolding, fund, () => 'bucket');

    expect(grouped?.get('bucket')?.real).toBe(0.02);
  });

  it('txnTypeLabel renders correct labels for FoF Sell and Buy transactions', () => {
    const fofHolding: Holding = {
      id: 'fof-1',
      n: 'Venture Fund I',
      tp: 'Fund of funds',
      dt: '2024-01-01',
      cost: 100,
      fmv: 120,
      real: 0,
      moic: 1.2,
      st: 'Active',
    };

    expect(
      txnTypeLabel(
        { type: 'Sell', sellProceedsDestination: 'distributed_to_investor' },
        fofHolding,
      ),
    ).toBe('Distribution');

    expect(
      txnTypeLabel(
        { type: 'Sell', sellProceedsDestination: 'cash_in_fund' },
        fofHolding,
      ),
    ).toBe('Divestment');

    expect(
      txnTypeLabel(
        { type: 'Buy' },
        fofHolding,
      ),
    ).toBe('Capital call');
  });

  it('txnTypeLabel renders correct labels for Cash Sell and Buy transactions', () => {
    const cashHolding: Holding = {
      id: 'cash-1',
      n: 'Cash - USD',
      tp: 'Cash',
      dt: '2024-01-01',
      cost: 0,
      fmv: 100,
      real: 0,
      moic: 1,
      st: 'Active',
    };

    expect(
      txnTypeLabel(
        { type: 'Sell', sellProceedsDestination: 'distributed_to_investor' },
        cashHolding,
      ),
    ).toBe('Distribution');

    expect(
      txnTypeLabel(
        { type: 'Sell', sellProceedsDestination: 'cash_in_fund' },
        cashHolding,
      ),
    ).toBe('Withdrawal');

    expect(
      txnTypeLabel(
        { type: 'Buy' },
        cashHolding,
      ),
    ).toBe('Deposit');
  });

  it('computeFoF counts Sell transactions into totalDist', () => {
    const fofHolding: Holding = {
      id: 'fof-1',
      n: 'Venture Fund I',
      tp: 'Fund of funds',
      dt: '2024-01-01',
      cost: 100,
      fmv: 120,
      real: 0,
      moic: 1.2,
      st: 'Active',
      inv: {
        txns: [
          { date: '2024-01-01', type: 'Buy', value: 100 },
          {
            date: '2024-06-01',
            type: 'Sell',
            value: 30,
            sellProceedsDestination: 'distributed_to_investor',
          },
          {
            date: '2024-09-01',
            type: 'Sell',
            value: 20,
            sellProceedsDestination: 'cash_in_fund',
          },
        ],
        quarterly: [],
      },
    };

    const metrics = computeFoF(fofHolding)!;
    expect(metrics.totalCalled).toBe(100);
    expect(metrics.totalDist).toBe(50);
    expect(metrics.callsCount).toBe(1);
    expect(metrics.distsCount).toBe(2);
    expect(metrics.netDist).toBe(50);
  });

  it('txnTypeLabel renders Reversal labels accurately without implying Retained sale proceeds', () => {
    const directHolding: Holding = {
      id: 'h-1',
      n: 'Company A',
      tp: 'Equity',
      dt: '2024-01-01',
      cost: 100,
      fmv: 120,
      real: 0,
      moic: 1.2,
      st: 'Active',
    };

    // Generic reversal of purchase
    expect(
      txnTypeLabel(
        { type: 'Buy', isReversal: true },
        directHolding,
      ),
    ).toBe('Reversal: Purchase');

    // Reversal of interest income
    expect(
      txnTypeLabel(
        { type: 'Other', label: 'Interest income', isReversal: true },
        directHolding,
      ),
    ).toBe('Reversal: Interest income');

    // FoF reversal of capital call
    const fofHolding: Holding = {
      id: 'fof-1',
      n: 'Venture Fund I',
      tp: 'Fund of funds',
      dt: '2024-01-01',
      cost: 100,
      fmv: 120,
      real: 0,
      moic: 1.2,
      st: 'Active',
    };
    expect(
      txnTypeLabel(
        { type: 'Buy', isReversal: true },
        fofHolding,
      ),
    ).toBe('Reversal: Capital call');
  });
});

describe('calculateXirr and dated cash flow IRR', () => {
  it('computes exact annualized XIRR for simple 1-year 10% return', () => {
    const flows = [
      { date: '2020-01-01', amount: -100 },
      { date: '2021-01-01', amount: 110 },
    ];
    const xirr = calculateXirr(flows);
    // 366 days in 2020 (leap year) -> ~10%
    expect(xirr.status).toBe('calculated');
    expect(xirr.reason).toBe('calculated');
    expect(xirr.value).toBeCloseTo(0.10, 2);
  });

  it('computes exact annualized XIRR for multi-period cash flows with distributions and terminal FMV', () => {
    const flows = [
      { date: '2020-01-01', amount: -100 },
      { date: '2021-01-01', amount: 20 },
      { date: '2022-01-01', amount: 110 },
    ];
    const xirr = calculateXirr(flows);
    // Analytical root of -100 + 20/(1+r) + 110/(1+r)^2 = 0 is ~15.34%
    expect(xirr.status).toBe('calculated');
    expect(xirr.reason).toBe('calculated');
    expect(xirr.value).toBeCloseTo(0.1534, 2);
  });

  it('returns unavailable status when there are no cash flows or all cash flows have the same sign', () => {
    expect(calculateXirr([])).toEqual({
      value: null,
      status: 'unavailable',
      reason: 'insufficient_flows',
    });
    expect(calculateXirr([{ date: '2020-01-01', amount: -100 }])).toEqual({
      value: null,
      status: 'unavailable',
      reason: 'insufficient_flows',
    });
    expect(
      calculateXirr([
        { date: '2020-01-01', amount: -100 },
        { date: '2021-01-01', amount: -50 },
      ]),
    ).toEqual({
      value: null,
      status: 'unavailable',
      reason: 'no_sign_change',
    });
    expect(
      calculateXirr([
        { date: '2020-01-01', amount: 100 },
        { date: '2021-01-01', amount: 50 },
      ]),
    ).toEqual({
      value: null,
      status: 'unavailable',
      reason: 'no_sign_change',
    });
  });

  it('preserves genuine 0% return staying 0 with calculated status', () => {
    const flows = [
      { date: '2020-01-01', amount: -100 },
      { date: '2021-01-01', amount: 100 },
    ];
    const res = calculateXirr(flows);
    expect(res.status).toBe('calculated');
    expect(res.reason).toBe('calculated');
    expect(res.value).toBe(0);
  });

  it('returns unavailable for one cash flow, all-zero flows, or invalid dates', () => {
    // One flow
    expect(calculateXirr([{ date: '2020-01-01', amount: -100 }])).toEqual({
      value: null,
      status: 'unavailable',
      reason: 'insufficient_flows',
    });

    // All-zero flows
    expect(
      calculateXirr([
        { date: '2020-01-01', amount: 0 },
        { date: '2021-01-01', amount: 0 },
      ]),
    ).toEqual({
      value: null,
      status: 'unavailable',
      reason: 'insufficient_flows',
    });

    // Invalid date string
    expect(
      calculateXirr([
        { date: 'invalid-date', amount: -100 },
        { date: '2021-01-01', amount: 100 },
      ]),
    ).toEqual({
      value: null,
      status: 'unavailable',
      reason: 'insufficient_flows',
    });
  });

  it('returns unavailable with did_not_converge reason when solver fails to find a root', () => {
    // Non-conventional cash flow series with no real discount rate root (discriminant < 0)
    const nonConvergentFlows = [
      { date: '2020-01-01', amount: 100 },
      { date: '2020-07-02', amount: -210 },
      { date: '2021-01-01', amount: 111 },
    ];
    const res = calculateXirr(nonConvergentFlows);
    expect(res.status).toBe('unavailable');
    expect(res.reason).toBe('did_not_converge');
    expect(res.value).toBeNull();
  });
});

describe('Quarterly history and absence of synthetic marks (F06)', () => {
  it('returns an empty array when a position has no observed quarterly history (no factors fabrication)', () => {
    const holdingNoHistory = makeHolding({
      id: 'h-no-hist',
      cost: 10,
      fmv: 15,
      txns: [{ date: '2024-01-01', type: 'Buy', value: 10, shares: 1000 }],
    });
    holdingNoHistory.inv!.quarterly = [];

    const m = computeInv(holdingNoHistory);
    expect(m).not.toBeNull();
    // Must NOT fabricate 4 quarters with factors [0.86, 0.91, 0.96, 1.0]
    expect(m!.quarterly).toEqual([]);
  });

  it('passes observed quarterly marks through untouched when real history exists', () => {
    const realQuarter: Quarter = {
      q: 'Q1 2026',
      asOfDate: '2026-03-31',
      pps: 15.0,
      mv: 15.0,
      cost: 10.0,
      sharesOut: 1000,
      shPct: 5.0,
      moic: 1.5,
      xirr: 0.12,
      notes: 'Audited mark',
    };
    const holdingWithHistory = makeHolding({
      id: 'h-with-hist',
      cost: 10,
      fmv: 15,
      txns: [{ date: '2024-01-01', type: 'Buy', value: 10, shares: 1000 }],
    });
    holdingWithHistory.inv!.quarterly = [realQuarter];

    const m = computeInv(holdingWithHistory);
    expect(m).not.toBeNull();
    expect(m!.quarterly).toEqual([realQuarter]);
  });
});

describe('UI rendering of unavailable IRR and missing history (DOM tests)', () => {
  const renderWithTooltip = (el: React.ReactElement) =>
    renderToStaticMarkup(React.createElement(TooltipProvider, null, el));

  it('FoFDetail renders unavailable FoF XIRR with reason tooltip and no 0.0% false positive', () => {
    const fofHoldingUnavailable = makeHolding({
      id: 'h-fof-no-exit',
      tp: 'Fund of funds',
      cost: 5,
      fmv: 0,
      real: 0,
      txns: [
        { date: '2024-01-01', type: 'Buy', value: 5 },
        { date: '2024-06-01', type: 'Buy', value: 2 },
      ],
    });
    const fund = makeFund('f1', [fofHoldingUnavailable]);

    const html = renderWithTooltip(
      React.createElement(FoFDetail, { fund, holding: fofHoldingUnavailable }),
    );

    // Must show 'Unavailable' rather than '0.0%'
    expect(html).toContain('Unavailable');
    expect(html).not.toContain('0.0%');
    expect(html).toContain('cash flows do not change sign');
  });

  it('FoFDetail renders calculated FoF XIRR when cash flows are valid', () => {
    const fofHoldingCalculated = makeHolding({
      id: 'h-fof-calc',
      tp: 'Fund of funds',
      cost: 10,
      fmv: 11,
      real: 2,
      txns: [
        { date: '2020-01-01', type: 'Buy', value: 10 },
        { date: '2021-01-01', type: 'Sell', value: 2 },
      ],
    });
    const fund = makeFund('f1', [fofHoldingCalculated]);

    const html = renderWithTooltip(
      React.createElement(FoFDetail, { fund, holding: fofHoldingCalculated }),
    );

    expect(html).toContain('XIRR');
    expect(html).not.toContain('Unavailable');
    // Calculated percentage is present
    expect(html).toMatch(/\d+\.\d+%/);
  });

  it('QuarterTable renders empty message and no sparkline when history is absent', () => {
    const equityHoldingNoHist = makeHolding({
      id: 'h-eq-no-hist',
      tp: 'Equity',
      cost: 10,
      fmv: 10,
      real: 0,
      txns: [{ date: '2024-01-01', type: 'Buy', value: 10, shares: 1000 }],
    });
    equityHoldingNoHist.inv!.quarterly = [];
    const fund = makeFund('f1', [equityHoldingNoHist]);

    const html = renderWithTooltip(
      React.createElement(QuarterTable, { fund, holding: equityHoldingNoHist, equity: true }),
    );

    expect(html).toContain('No quarterly valuation history recorded');
  });

  it('computes tvpiHist when real === 0 without fabricated multipliers, and returns null for non-final quarters when real > 0 and realization history is absent', () => {
    // 1. real === 0 case: TVPI = FMV / Called
    const fundZeroReal: Fund = {
      id: 'f-zero-real',
      n: 'Zero Real Fund',
      v: 2024,
      size: 50,
      called: 20,
      calledPct: 40,
      fmv: 30,
      real: 0,
      dpi: 0,
      tvpi: 1.5,
      irr: 0,
      st: 'Investing',
      h: [],
      valuationCoverage: 'complete',
      hist: {
        committed: [50, 50, 50, 50],
        called: [10, 10, 20, 20],
        fmv: [12, 14, 25, 30],
      },
    };
    const totalsZeroReal = portfolioTotals([fundZeroReal]);
    expect(totalsZeroReal.tvpiHist).toEqual([1.2, 1.4, 1.25, 1.5]);

    // 2. real > 0 case without quarterly realization history: non-final quarters MUST BE null, final quarter is exact
    const fundWithReal: Fund = {
      id: 'f-with-real',
      n: 'With Real Fund',
      v: 2024,
      size: 50,
      called: 20,
      calledPct: 40,
      fmv: 30,
      real: 5,
      dpi: 0.25,
      tvpi: 1.75,
      irr: 0,
      st: 'Investing',
      h: [],
      valuationCoverage: 'complete',
      hist: {
        committed: [50, 50, 50, 50],
        called: [10, 10, 20, 20],
        fmv: [12, 14, 25, 30],
      },
    };
    const totalsWithReal = portfolioTotals([fundWithReal]);
    // Non-final quarters (indices 0, 1, 2) must be null — not fabricated with 0.85 * real
    expect(totalsWithReal.tvpiHist[0]).toBeNull();
    expect(totalsWithReal.tvpiHist[1]).toBeNull();
    expect(totalsWithReal.tvpiHist[2]).toBeNull();
    // Final quarter (index 3) is exact: (30 + 5) / 20 = 1.75
    expect(totalsWithReal.tvpiHist[3]).toBeCloseTo(1.75, 2);
  });
});

describe('Valuation availability and valuation coverage signals', () => {
  it('computeInv returns null for valuation-dependent metrics when holding has no valuation (fmv === null)', () => {
    const unvaluedHolding: Holding = {
      id: 'h-unvalued',
      n: 'Seed Stage Co',
      tp: 'Equity',
      dt: '2024-01-01',
      cost: 1.0, // 1M
      fmv: null,
      real: 0.2, // 200k
      moic: null,
      st: 'Active',
      inv: {
        txns: [
          { date: '2024-01-01', type: 'Buy', value: 1.0, shares: 100000 },
          { date: '2025-01-01', type: 'Sell', value: 0.2, shares: 20000 },
        ],
        quarterly: [],
      },
    };

    const metrics = computeInv(unvaluedHolding);
    expect(metrics).not.toBeNull();
    expect(metrics!.investedCapital).toBe(1.0);
    expect(metrics!.realizedProceedsGross).toBe(0.2);
    expect(metrics!.sharesAcquired).toBe(100000);
    expect(metrics!.sharesDisposed).toBe(20000);
    expect(metrics!.sharesHeld).toBe(80000);
    expect(metrics!.dpi).toBe(0.2); // DPI is computable: 0.2 / 1.0 = 0.2

    // Valuation-dependent metrics must be null
    expect(metrics!.curPrice).toBeNull();
    expect(metrics!.unrealizedValue).toBeNull();
    expect(metrics!.totalValueGross).toBeNull();
    expect(metrics!.totalGrossGain).toBeNull();
    expect(metrics!.netTotalValue).toBeNull();
    expect(metrics!.grossMOIC).toBeNull();
    expect(metrics!.netMOIC).toBeNull();
    expect(metrics!.grossIRR).toBeNull();
    expect(metrics!.unreal).toBeNull();
  });

  it('computeFoF returns null for valuation-dependent metrics when holding has no valuation (fmv === null)', () => {
    const unvaluedFoF: Holding = {
      id: 'h-fof-unvalued',
      n: 'Venture Partners VII',
      tp: 'Fund of funds',
      dt: '2024-01-01',
      cost: 2.0, // 2M
      fmv: null,
      real: 0.5, // 500k
      moic: null,
      st: 'Active',
      inv: {
        txns: [
          { date: '2024-01-01', type: 'Buy', value: 2.0 },
          { date: '2025-01-01', type: 'Sell', value: 0.5 },
        ],
        quarterly: [],
      },
    };

    const metrics = computeFoF(unvaluedFoF);
    expect(metrics).not.toBeNull();
    expect(metrics!.totalCalled).toBe(2.0);
    expect(metrics!.totalDist).toBe(0.5);
    expect(metrics!.costInv).toBe(2.0);
    expect(metrics!.netDist).toBe(0.5);
    expect(metrics!.dpi).toBe(0.25); // 0.5 / 2.0 = 0.25

    // Valuation-dependent metrics must be null
    expect(metrics!.marketValue).toBeNull();
    expect(metrics!.moic).toBeNull();
    expect(metrics!.xirr).toBeNull();
  });

  it('holdingsPortfolioTotals signals valuationCoverage: "partial" and moic: null when at least one holding lacks valuation', () => {
    const fund1 = makeFund('f1', [
      makeHolding({ id: 'h1', cost: 10, fmv: 15, real: 2 }),
      makeHolding({ id: 'h2', cost: 5, fmv: null as any, real: 1 }),
    ]);

    const totals = holdingsPortfolioTotals([fund1]);
    expect(totals.valuationCoverage).toBe('partial');
    expect(totals.invested).toBe(15);
    expect(totals.fmv).toBe(15); // Sum of available valued holdings
    expect(totals.real).toBe(3);
    expect(totals.moic).toBeNull();
  });

  it('holdingsPortfolioTotals signals valuationCoverage: "complete" and computes moic when all holdings are valued', () => {
    const fund1 = makeFund('f1', [
      makeHolding({ id: 'h1', cost: 10, fmv: 15, real: 2 }),
      makeHolding({ id: 'h2', cost: 5, fmv: 5, real: 1 }),
    ]);

    const totals = holdingsPortfolioTotals([fund1]);
    expect(totals.valuationCoverage).toBe('complete');
    expect(totals.invested).toBe(15);
    expect(totals.fmv).toBe(20);
    expect(totals.real).toBe(3);
    expect(totals.moic).toBe((20 + 3) / 15);
  });

  it('portfolioTotals signals valuationCoverage: "partial" and moic: null when a fund has partial valuation coverage', () => {
    const fund1 = makeFund('f1', []);
    fund1.size = 100;
    fund1.called = 40;
    fund1.fmv = 30;
    fund1.real = 10;
    fund1.valuationCoverage = 'partial';

    const totals = portfolioTotals([fund1]);
    expect(totals.valuationCoverage).toBe('partial');
    expect(totals.moic).toBeNull();
  });

  it('sumSlices and aggregateByTxn signal valuationCoverage: "partial" and return null gain and moic when slices lack valuation', () => {
    const slices = [
      { cost: 10, fmv: 20, real: 5 },
      { cost: 10, fmv: null, real: 2 },
    ];

    const sum = sumSlices(slices);
    expect(sum.valuationCoverage).toBe('partial');
    expect(sum.cost).toBe(20);
    expect(sum.fmv).toBe(20);
    expect(sum.real).toBe(7);
    expect(sum.gain).toBeNull();
    expect(sum.moic).toBeNull();
  });
});

describe('Append-only reversals date-aware metrics (computeInv & computeFoF)', () => {
  it('computeInv preserves original invested economics as-of 2026-03-31, and reflects reversal/net zero on or after 2026-05-20', () => {
    const holding: Holding = {
      id: 'h-inv-reversal',
      n: 'Test Asset',
      tp: 'Equity',
      dt: '2026-01-15',
      cost: 10,
      fmv: null,
      real: 0,
      moic: null,
      st: 'Active',
      inv: {
        txns: [
          {
            id: 'txn-orig',
            date: '2026-01-15',
            type: 'Buy',
            value: 10,
            shares: 100,
            pps: 100,
            isReversedOriginal: true,
            reversalDate: '2026-05-20',
          },
          {
            id: 'txn-rev',
            date: '2026-05-20',
            type: 'Buy',
            value: -10,
            shares: -100,
            isReversal: true,
          },
        ],
        quarterly: [],
      },
    };

    // As of 2026-03-31 (before reversal date 2026-05-20), original invested economics must remain
    const asOfBefore = computeInv(holding, '2026-03-31');
    expect(asOfBefore).not.toBeNull();
    expect(asOfBefore!.investedCapital).toBe(10);
    expect(asOfBefore!.sharesHeld).toBe(100);

    // Also via holding-level asOfDate
    const holdingBefore: Holding = { ...holding, asOfDate: '2026-03-31' };
    expect(computeInv(holdingBefore)!.investedCapital).toBe(10);
    expect(computeInv(holdingBefore)!.sharesHeld).toBe(100);

    // As of 2026-05-20 (reversal date), reflects reversal/net zero
    const asOfReversal = computeInv(holding, '2026-05-20');
    expect(asOfReversal).not.toBeNull();
    expect(asOfReversal!.investedCapital).toBe(0);
    expect(asOfReversal!.sharesHeld).toBe(0);

    // As of 2026-06-30 (later date), reflects reversal/net zero
    const asOfLater = computeInv(holding, '2026-06-30');
    expect(asOfLater).not.toBeNull();
    expect(asOfLater!.investedCapital).toBe(0);
    expect(asOfLater!.sharesHeld).toBe(0);

    // Current date (no asOfDate) reflects reversal/net zero
    const current = computeInv(holding);
    expect(current).not.toBeNull();
    expect(current!.investedCapital).toBe(0);
    expect(current!.sharesHeld).toBe(0);
  });

  it('computeFoF preserves original invested economics as-of 2026-03-31, and reflects reversal/net zero on or after 2026-05-20', () => {
    const fofHolding: Holding = {
      id: 'h-fof-reversal',
      n: 'Test Fund of Funds',
      tp: 'Fund of funds',
      dt: '2026-01-15',
      cost: 10,
      fmv: null,
      real: 0,
      moic: null,
      st: 'Active',
      inv: {
        txns: [
          {
            id: 'txn-orig',
            date: '2026-01-15',
            type: 'Buy',
            value: 10,
            isReversedOriginal: true,
            reversalDate: '2026-05-20',
          },
          {
            id: 'txn-rev',
            date: '2026-05-20',
            type: 'Buy',
            value: -10,
            isReversal: true,
          },
        ],
        quarterly: [],
      },
    };

    // As of 2026-03-31 (before reversal date), original invested economics must remain
    const asOfBefore = computeFoF(fofHolding, '2026-03-31');
    expect(asOfBefore).not.toBeNull();
    expect(asOfBefore!.costInv).toBe(10);
    expect(asOfBefore!.totalCalled).toBe(10);

    // Also via holding-level asOfDate
    const holdingBefore: Holding = { ...fofHolding, asOfDate: '2026-03-31' };
    expect(computeFoF(holdingBefore)!.costInv).toBe(10);
    expect(computeFoF(holdingBefore)!.totalCalled).toBe(10);

    // As of 2026-05-20 (reversal date), reflects reversal/net zero
    const asOfReversal = computeFoF(fofHolding, '2026-05-20');
    expect(asOfReversal).not.toBeNull();
    expect(asOfReversal!.costInv).toBe(0);
    expect(asOfReversal!.totalCalled).toBe(0);

    // As of 2026-06-30 (later date), reflects reversal/net zero
    const asOfLater = computeFoF(fofHolding, '2026-06-30');
    expect(asOfLater).not.toBeNull();
    expect(asOfLater!.costInv).toBe(0);
    expect(asOfLater!.totalCalled).toBe(0);

    // Current date (no asOfDate) reflects reversal/net zero
    const current = computeFoF(fofHolding);
    expect(current).not.toBeNull();
    expect(current!.costInv).toBe(0);
    expect(current!.totalCalled).toBe(0);
  });

  describe('Phase 6: recomputeFund for active cash ledger funds (Row 6)', () => {
    it('keeps served cash out of FMV but in TVPI, and does not re-derive retained cash', () => {
      const holdingWithRetainedSale = makeHolding({
        id: 'h1',
        cost: 3,
        fmv: 5,
        real: 1,
        txns: [
          {
            date: '2024-01-01',
            type: 'Sell',
            value: 2, // 2M retained sale
            fundId: 'f1',
            sellProceedsDestination: 'cash_in_fund',
          },
        ],
      });

      const activeFund: Fund = {
        id: 'f1',
        n: 'Active Fund',
        v: 2024,
        size: 10,
        called: 5,
        calledPct: 50,
        fmv: 5, // 5M holding FMV (cash is never Unrealized MV)
        real: 1,
        dpi: 0.2,
        tvpi: 1.8,
        irr: 0,
        st: 'Investing',
        h: [holdingWithRetainedSale],
        valuationCoverage: 'complete',
        cashBalance: 3, // Served cash balance from backend = 3M
        hist: {
          committed: [10],
          called: [5],
          fmv: [8],
        },
      };

      recomputeFund(activeFund);

      // Unrealized MV = 5M holding FMV only; the 3M served cash is not market value.
      expect(activeFund.fmv).toBe(5);
      // TVPI keeps NAV = 5M holdings + 3M served cash (NOT the 2M re-derived from txns): (8M + 1M) / 5M
      expect(activeFund.tvpi).toBeCloseTo(1.8, 6);
      // History FMV must agree with current FMV
      expect(activeFund.hist!.fmv[activeFund.hist!.fmv.length - 1]).toBe(5);
    });

    it('recomputeFund keeps holdings-only FMV but nulls TVPI when the fund\'s cash is pending_fx', () => {
      const pendingFxFund: Fund = {
        id: 'f-pfx',
        n: 'Pending FX Fund',
        v: 2024,
        size: 20,
        called: 10,
        calledPct: 50,
        fmv: null,
        real: 2,
        dpi: 0.2,
        tvpi: null,
        irr: 0,
        st: 'Investing',
        h: [
          makeHolding({
            id: 'h1',
            cost: 8,
            fmv: 12,
            real: 1,
          }),
        ],
        valuationCoverage: 'complete',
        fxStatus: 'pending_fx',
        reportingTotalAvailable: false,
        cashBalance: null,
        rawFmv: null,
      };

      recomputeFund(pendingFxFund);

      // Cash FX status cannot block Unrealized MV, which never includes cash
      expect(pendingFxFund.fmv).toBe(12);
      // TVPI needs NAV (holdings + cash), which is unavailable until FX is resolved
      expect(pendingFxFund.tvpi).toBeNull();
    });

    it('recomputeFund shows no FMV ("—") when no holding is valued, even though the fund holds cash', () => {
      const unvaluedFund: Fund = {
        id: 'f-unvalued',
        n: 'Unvalued Fund',
        v: 2024,
        size: 20,
        called: 10,
        calledPct: 50,
        fmv: null,
        real: 0,
        dpi: 0,
        tvpi: null,
        irr: 0,
        st: 'Investing',
        h: [makeHolding({ id: 'h1', cost: 10, fmv: null, real: 0 })],
        valuationCoverage: 'partial',
        fxStatus: 'available',
        reportingTotalAvailable: true,
        cashBalance: 30,
        hist: { committed: [20], called: [10], fmv: [0] },
      };

      recomputeFund(unvaluedFund);

      expect(unvaluedFund.fmv).toBeNull();
      expect(unvaluedFund.tvpi).toBeNull();
      expect(unvaluedFund.hist!.fmv).toEqual([0]);
    });
  });

  describe('portfolioTotals and holdingsPortfolioTotals with pending_fx', () => {
    it('keeps holdings-only FMV and MOIC when a fund\'s cash is pending_fx', () => {
      const normalFund: Fund = {
        id: 'f1',
        n: 'Normal Fund',
        v: 2024,
        size: 10,
        called: 5,
        calledPct: 50,
        fmv: 7,
        real: 2,
        dpi: 0.4,
        tvpi: 2.0,
        irr: 0,
        st: 'Investing',
        h: [makeHolding({ id: 'h1', cost: 4, fmv: 7, real: 1 })],
        valuationCoverage: 'complete',
        fxStatus: 'available',
        reportingTotalAvailable: true,
        cashBalance: 1,
      };

      const pendingFxFund: Fund = {
        id: 'f2',
        n: 'Pending FX Fund',
        v: 2024,
        size: 20,
        called: 10,
        calledPct: 50,
        fmv: 10,
        real: 1,
        dpi: 0.1,
        tvpi: null,
        irr: 0,
        st: 'Investing',
        h: [makeHolding({ id: 'h2', cost: 8, fmv: 10, real: 1 })],
        valuationCoverage: 'complete',
        fxStatus: 'pending_fx',
        reportingTotalAvailable: false,
        cashBalance: null,
        rawFmv: null,
      };

      const funds = [normalFund, pendingFxFund];

      // Cash (and its FX status) never enters Unrealized MV or MOIC, so pending FX does not blank them
      const pTotals = portfolioTotals(funds);
      expect(pTotals.fmv).toBe(17);
      expect(pTotals.valuationCoverage).toBe('complete');
      expect(pTotals.moic).toBeCloseTo((17 + 3) / 15, 6);

      const hTotals = holdingsPortfolioTotals(funds);
      expect(hTotals.fmv).toBe(17);
      expect(hTotals.valuationCoverage).toBe('complete');
      expect(hTotals.moic).toBeCloseTo((17 + 2) / 12, 6);
    });

    it('excludes cash from portfolio FMV and MOIC, and shows no FMV when nothing is valued', () => {
      const valuedWithCash: Fund = {
        id: 'f-valued',
        n: 'Valued Fund',
        v: 2024,
        size: 10,
        called: 5,
        calledPct: 50,
        fmv: 6,
        real: 1,
        dpi: 0.2,
        tvpi: 2.0,
        irr: 0,
        st: 'Investing',
        h: [makeHolding({ id: 'h-v', cost: 4, fmv: 6, real: 1 })],
        valuationCoverage: 'complete',
        fxStatus: 'available',
        reportingTotalAvailable: true,
        cashBalance: 3,
      };
      const t = holdingsPortfolioTotals([valuedWithCash]);
      expect(t.fmv).toBe(6);
      expect(t.moic).toBeCloseTo((6 + 1) / 4, 6);
      const p = portfolioTotals([valuedWithCash]);
      expect(p.fmv).toBe(6);
      expect(p.moic).toBeCloseTo((6 + 1) / 5, 6);

      const unvaluedWithCash: Fund = {
        ...valuedWithCash,
        id: 'f-unvalued',
        fmv: null,
        tvpi: null,
        h: [makeHolding({ id: 'h-u', cost: 4, fmv: null, real: 0 })],
        valuationCoverage: 'partial',
        cashBalance: 30,
      };
      const tu = holdingsPortfolioTotals([unvaluedWithCash]);
      expect(tu.fmv).toBeNull();
      expect(tu.moic).toBeNull();
      expect(tu.valuationCoverage).toBe('partial');
      const pu = portfolioTotals([unvaluedWithCash]);
      expect(pu.fmv).toBeNull();
      expect(pu.moic).toBeNull();

      // One valued holding among unvalued ones: partial sum of the valued holdings, MOIC withheld
      const partial = holdingsPortfolioTotals([valuedWithCash, unvaluedWithCash]);
      expect(partial.fmv).toBe(6);
      expect(partial.valuationCoverage).toBe('partial');
      expect(partial.moic).toBeNull();
    });
  });

  describe('Null-propagating historical totals', () => {
    it('sumHist propagates explicit null values and preserves neutral behavior for missing history', () => {
      const fundWithNulls: Fund = {
        id: 'f-null',
        n: 'Fund With Nulls',
        v: 2024,
        size: 10,
        called: 5,
        calledPct: 50,
        fmv: null,
        real: 0,
        dpi: 0,
        tvpi: null,
        irr: 0,
        st: 'Investing',
        h: [],
        hist: {
          committed: [10, 10, 10, 10],
          called: [5, 5, 5, 5],
          fmv: [8, 8, null, null],
        },
      };

      const fundNormal: Fund = {
        id: 'f-normal',
        n: 'Fund Normal',
        v: 2024,
        size: 20,
        called: 10,
        calledPct: 50,
        fmv: 15,
        real: 2,
        dpi: 0.2,
        tvpi: 1.7,
        irr: 0,
        st: 'Investing',
        h: [],
        hist: {
          committed: [20, 20, 20, 20],
          called: [10, 10, 10, 10],
          fmv: [12, 12, 14, 15],
        },
      };

      const fundNoHist: Fund = {
        id: 'f-nohist',
        n: 'Fund No Hist',
        v: 2024,
        size: 5,
        called: 2,
        calledPct: 40,
        fmv: 3,
        real: 0,
        dpi: 0,
        tvpi: 1.5,
        irr: 0,
        st: 'Investing',
        h: [],
        // hist is undefined (missing history)
      };

      // When combining fundWithNulls and fundNormal:
      // Quarters 0 and 1: sum normal numbers (8+12=20, 8+12=20)
      // Quarters 2 and 3: fundWithNulls has explicit null -> aggregate must be null, NOT partial total (14, 15)
      const mixedFmvHist = sumHist([fundWithNulls, fundNormal], 'fmv');
      expect(mixedFmvHist).toEqual([20, 20, null, null]);

      // Missing history retains existing neutral behavior (contributes 0, does not propagate null)
      const neutralHist = sumHist([fundNormal, fundNoHist], 'fmv');
      expect(neutralHist).toEqual([12, 12, 14, 15]);
    });

    it('growth returns null when either current or prior quarter is null', () => {
      // Normal growth
      expect(growth([10, 20])).toBe(100);
      expect(growth([20, 10])).toBe(-50);
      expect(growth([10, 10])).toBe(0);

      // Current quarter is null
      expect(growth([10, null])).toBeNull();
      expect(growth([10, 20, null])).toBeNull();

      // Prior quarter is null
      expect(growth([null, 20])).toBeNull();
      expect(growth([10, null, 20])).toBeNull();

      // Both null
      expect(growth([null, null])).toBeNull();

      // Array length < 2
      expect(growth([])).toBe(0);
      expect(growth([10])).toBe(0);
    });

    it('single fund with pending-FX cash still reports holdings-only FMV, MOIC and FMV history', () => {
      const singlePendingFxFund: Fund = {
        id: 'f-pfx-single',
        n: 'Single Pending FX Fund',
        v: 2024,
        size: 30,
        called: 15,
        calledPct: 50,
        fmv: 20,
        real: 3,
        dpi: 0.2,
        tvpi: null,
        irr: 0,
        st: 'Investing',
        h: [makeHolding({ id: 'h1', cost: 15, fmv: 20, real: 3 })],
        valuationCoverage: 'complete',
        fxStatus: 'pending_fx',
        reportingTotalAvailable: false,
        cashBalance: null,
        rawFmv: '20000000.00000000',
        rawNav: null,
        hist: {
          committed: [30, 30, 30, 30],
          called: [10, 12, 15, 15],
          fmv: [15, 18, 19, 20], // Holdings-only: cash FX status does not blank it
        },
      };

      const pTotals = portfolioTotals([singlePendingFxFund]);
      expect(pTotals.fmv).toBe(20);
      expect(pTotals.moic).toBeCloseTo((20 + 3) / 15, 6);
      expect(pTotals.fmvHist).toEqual([15, 18, 19, 20]);
      // Multiple history: non-final quarters are null when realization history is absent (no fabricated 0.85 multiplier)
      expect(pTotals.tvpiHist[0]).toBeNull();
      expect(pTotals.tvpiHist[1]).toBeNull();
      expect(pTotals.tvpiHist[2]).toBeNull();
      expect(pTotals.tvpiHist[3]).toBeCloseTo((20 + 3) / 15, 6);
      expect(growth(pTotals.fmvHist)).toBeCloseTo(((20 - 19) / 19) * 100, 6);

      const hTotals = holdingsPortfolioTotals([singlePendingFxFund]);
      expect(hTotals.fmv).toBe(20);
      expect(hTotals.moic).toBeCloseTo((20 + 3) / 15, 6);
      expect(hTotals.fmvHist).toEqual([15, 18, 19, 20]);
    });

    it('mixed portfolio (available + pending-FX cash) sums holdings-only FMV and MOIC across both funds', () => {
      const normalFund: Fund = {
        id: 'f-norm',
        n: 'Available Fund',
        v: 2024,
        size: 20,
        called: 10,
        calledPct: 50,
        fmv: 14,
        real: 4,
        dpi: 0.4,
        tvpi: 2.0,
        irr: 12,
        st: 'Investing',
        h: [makeHolding({ id: 'h-norm', cost: 10, fmv: 14, real: 4 })],
        valuationCoverage: 'complete',
        fxStatus: 'available',
        reportingTotalAvailable: true,
        cashBalance: 2,
        hist: {
          committed: [20, 20, 20, 20],
          called: [5, 8, 10, 10],
          fmv: [8, 12, 13, 14],
        },
      };

      const pendingFxFund: Fund = {
        id: 'f-pfx',
        n: 'Pending FX Fund',
        v: 2024,
        size: 30,
        called: 15,
        calledPct: 50,
        fmv: 18,
        real: 2,
        dpi: 0.13,
        tvpi: null,
        irr: 0,
        st: 'Investing',
        h: [makeHolding({ id: 'h-pfx', cost: 15, fmv: 18, real: 2 })],
        valuationCoverage: 'complete',
        fxStatus: 'pending_fx',
        reportingTotalAvailable: false,
        cashBalance: null,
        rawFmv: '18000000.00000000',
        rawNav: null,
        hist: {
          committed: [30, 30, 30, 30],
          called: [5, 10, 15, 15],
          fmv: [10, 14, 16, 18], // Holdings-only: not blanked by pending-FX cash
        },
      };

      const funds = [normalFund, pendingFxFund];

      const pTotals = portfolioTotals(funds);
      expect(pTotals.fmv).toBe(32);
      expect(pTotals.moic).toBeCloseTo((32 + 6) / 25, 6);
      expect(pTotals.valuationCoverage).toBe('complete');
      // Committed & called sum normally
      expect(pTotals.committedHist).toEqual([50, 50, 50, 50]);
      expect(pTotals.calledHist).toEqual([10, 18, 25, 25]);
      expect(pTotals.fmvHist).toEqual([18, 26, 29, 32]);
      // Q0 & Q1 are null because real > 0 with no realization history (no fabricated 0.85)
      expect(pTotals.tvpiHist[0]).toBeNull();
      expect(pTotals.tvpiHist[1]).toBeNull();

      const hTotals = holdingsPortfolioTotals(funds);
      expect(hTotals.fmv).toBe(32);
      expect(hTotals.moic).toBeCloseTo((32 + 6) / 25, 6);
      expect(hTotals.valuationCoverage).toBe('complete');
      expect(hTotals.fmvHist).toEqual([18, 26, 29, 32]);
    });

    it('DeltaBadge renders unavailable status when pct is null', () => {
      const renderWithTooltip = (el: React.ReactElement) =>
        renderToStaticMarkup(React.createElement(TooltipProvider, null, el));

      const htmlNull = renderWithTooltip(React.createElement(DeltaBadge, { pct: null }));
      expect(htmlNull).toContain('– unavailable');
      expect(htmlNull).toContain('vs last quarter');

      const htmlPositive = renderWithTooltip(React.createElement(DeltaBadge, { pct: 12.4 }));
      expect(htmlPositive).toContain('▲ 12.4%');

      const htmlNegative = renderWithTooltip(React.createElement(DeltaBadge, { pct: -8.1 }));
      expect(htmlNegative).toContain('▼ 8.1%');

      const htmlZero = renderWithTooltip(React.createElement(DeltaBadge, { pct: 0 }));
      expect(htmlZero).toContain('– no change');
    });

    it('MetricCards shows holdings-only Unrealized MV for a fund whose cash is pending FX', () => {
      const renderWithTooltip = (el: React.ReactElement) =>
        renderToStaticMarkup(React.createElement(TooltipProvider, null, el));

      const pendingFxFund: Fund = {
        id: 'f-pfx-ui',
        n: 'Pending FX Fund',
        v: 2024,
        size: 20,
        called: 10,
        calledPct: 50,
        fmv: 15,
        real: 1,
        dpi: 0.1,
        tvpi: null,
        irr: 0,
        st: 'Investing',
        h: [makeHolding({ id: 'h1', cost: 10, fmv: 15, real: 1 })],
        valuationCoverage: 'complete',
        fxStatus: 'pending_fx',
        reportingTotalAvailable: false,
        cashBalance: null,
        rawFmv: '15000000.00000000',
        rawNav: null,
        hist: {
          committed: [20, 20, 20, 20],
          called: [5, 8, 10, 10],
          fmv: [10, 12, 15, 15],
        },
      };

      const html = renderWithTooltip(React.createElement(MetricCards, { funds: [pendingFxFund] }));
      expect(html).not.toContain('Unavailable (Pending FX)');
      expect(html).toContain('$15M');
      expect(html).toContain('1.60×');
    });

    it('MetricCards shows "—" for Unrealized MV and MOIC when no holding is valued, even with cash', () => {
      const renderWithTooltip = (el: React.ReactElement) =>
        renderToStaticMarkup(React.createElement(TooltipProvider, null, el));

      const unvaluedFund: Fund = {
        id: 'f-unvalued-ui',
        n: 'Unvalued Fund',
        v: 2024,
        size: 30,
        called: 15,
        calledPct: 50,
        fmv: null,
        real: 0,
        dpi: 0,
        tvpi: null,
        irr: 0,
        st: 'Investing',
        h: [makeHolding({ id: 'h-u', cost: 15, fmv: null, real: 0 })],
        valuationCoverage: 'partial',
        fxStatus: 'available',
        reportingTotalAvailable: true,
        cashBalance: 30,
        hist: {
          committed: [30, 30, 30, 30],
          called: [5, 10, 15, 15],
          fmv: [0, 0, 0, 0],
        },
      };

      const html = renderWithTooltip(React.createElement(MetricCards, { funds: [unvaluedFund] }));
      const mvCard = html.slice(html.indexOf('Unrealized Market Value'), html.indexOf('MOIC</div>'));
      // The 30M of cash is never presented as market value
      expect(mvCard).not.toContain('$30M');
      expect(mvCard).toContain('—');
      // And with a holding-only history there is no phantom "return" badge
      expect(mvCard).toContain('– no change');
      expect(html).toContain('Unavailable (holdings lack valuation)');
    });
  });
});

describe('Phase 3f: entity holdings integration in merge, totals, and cards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const renderWithTooltip = (el: React.ReactElement) =>
    renderToStaticMarkup(React.createElement(TooltipProvider, null, el));

  it('1. The merge returns holdings from funds and entities in one list', () => {
    const fundHolding = makeHolding({ id: 'a1', cost: 100, fmv: 120 });
    const entityHolding = makeHolding({ id: 'a2', cost: 200, fmv: 250 });
    const fund = makeFund('f1', [fundHolding]);
    const entity = makeInvestor('e1', [entityHolding], 'Startech Group', 'Startech Ltd');

    const rows = mergeHoldingsAcrossFunds([fund], [entity]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.key)).toEqual(['a1', 'a2']);
    expect(rows[0].h).toBe(fundHolding);
    expect(rows[0].holders?.map((h) => h.name)).toEqual(['Fund f1']);
    expect(rows[1].h).toBe(entityHolding);
    expect(rows[1].holders?.map((h) => h.name)).toEqual(['Startech Ltd (Startech Group)']);

    // Also co-held asset merges into one row
    const coFundH = makeHolding({ id: 'a-shared', cost: 60, fmv: 80, real: 10 });
    coFundH.positionId = 'pos-fund-shared';
    const coEntityH = makeHolding({ id: 'a-shared', cost: 40, fmv: 60, real: 5 });
    coEntityH.positionId = 'pos-entity-shared';

    const mergedCoRows = mergeHoldingsAcrossFunds(
      [makeFund('f1', [coFundH])],
      [makeInvestor('e1', [coEntityH], 'Startech Group', 'Startech Ltd')],
    );
    expect(mergedCoRows).toHaveLength(1);
    expect(mergedCoRows[0].key).toBe('a-shared');
    expect(mergedCoRows[0].h.cost).toBeCloseTo(100);
    expect(mergedCoRows[0].h.fmv).toBeCloseTo(140);
    expect(mergedCoRows[0].h.real).toBeCloseTo(15);
    expect(mergedCoRows[0].holders?.map((h) => h.name)).toEqual([
      'Fund f1',
      'Startech Ltd (Startech Group)',
    ]);
  });

  it('2. The same position is never double-counted', () => {
    const h1 = makeHolding({ id: 'a1', cost: 100, fmv: 120 });
    h1.positionId = 'pos-dup-1';
    const h2 = makeHolding({ id: 'a1', cost: 100, fmv: 120 });
    h2.positionId = 'pos-dup-1'; // Same position ID

    const fund = makeFund('f1', [h1]);
    const entity = makeInvestor('e1', [h2]);

    const rows = mergeHoldingsAcrossFunds([fund], [entity]);
    expect(rows).toHaveLength(1);
    expect(rows[0].h.cost).toBe(100);

    const totals = holdingsPortfolioTotals([fund], [entity]);
    expect(totals.invested).toBe(100);

    // Also verify when same object reference is passed in both
    const sharedObj = makeHolding({ id: 'a-ref', cost: 75, fmv: 90 });
    const rowsObj = mergeHoldingsAcrossFunds([makeFund('f1', [sharedObj])], [makeInvestor('e1', [sharedObj])]);
    expect(rowsObj).toHaveLength(1);
    expect(rowsObj[0].h.cost).toBe(75);

    const totalsObj = holdingsPortfolioTotals([makeFund('f1', [sharedObj])], [makeInvestor('e1', [sharedObj])]);
    expect(totalsObj.invested).toBe(75);
  });

  it('3. An entity holding renders its entity name, and <entity> (<group>) when grouped', () => {
    const entityUngrouped = makeInvestor('e1', [makeHolding({ id: 'a1' })], null, 'Startech Ltd');
    expect(formatHolderName(entityUngrouped)).toBe('Startech Ltd');

    const entityGrouped = makeInvestor('e2', [makeHolding({ id: 'a2' })], 'Startech Group', 'Startech Ltd');
    expect(formatHolderName(entityGrouped)).toBe('Startech Ltd (Startech Group)');

    const fund = makeFund('f1', []);
    expect(formatHolderName(fund)).toBe('Fund f1');

    const rows = mergeHoldingsAcrossFunds([fund], [entityUngrouped, entityGrouped]);
    const rowUngrouped = rows.find((r) => r.key === 'a1');
    const rowGrouped = rows.find((r) => r.key === 'a2');

    expect(rowUngrouped?.holderNames).toEqual(['Startech Ltd']);
    expect(rowGrouped?.holderNames).toEqual(['Startech Ltd (Startech Group)']);
  });

  it('4. Portfolio totals include entity holdings; partial valuation coverage still yields "unavailable" rather than a wrong number', () => {
    const fundHolding = makeHolding({ id: 'a1', cost: 100, fmv: 150 });
    const fund = makeFund('f1', [fundHolding]);
    const entityHolding = makeHolding({ id: 'a2', cost: 50, fmv: 80 });
    const entity = makeInvestor('e1', [entityHolding]);

    const totalsComplete = holdingsPortfolioTotals([fund], [entity]);
    expect(totalsComplete.invested).toBe(150);
    expect(totalsComplete.fmv).toBe(230);
    expect(totalsComplete.valuationCoverage).toBe('complete');
    expect(totalsComplete.moic).toBeCloseTo(230 / 150);

    // Partial valuation coverage on entity holding
    const unvaluedHolding = makeHolding({ id: 'a3', cost: 40, fmv: null });
    const entityWithUnvalued = makeInvestor('e2', [unvaluedHolding]);

    const totalsPartial = holdingsPortfolioTotals([fund], [entityWithUnvalued]);
    expect(totalsPartial.invested).toBe(140);
    expect(totalsPartial.valuationCoverage).toBe('partial');
    expect(totalsPartial.moic).toBeNull();

    // MetricCards renders unavailable message for MOIC
    const htmlPartial = renderWithTooltip(
      React.createElement(MetricCards, { funds: [fund], investors: [entityWithUnvalued] }),
    );
    expect(htmlPartial).toContain('Unavailable (holdings lack valuation)');
  });

  it('5. Regression: with entities absent, every output is byte-identical to today\'s fund-only behaviour', () => {
    const fundHolding = makeHolding({ id: 'a1', cost: 100, fmv: 150 });
    const fund = makeFund('f1', [fundHolding]);

    const rowsWithoutSecondArg = mergeHoldingsAcrossFunds([fund]);
    const rowsWithEmptyEntities = mergeHoldingsAcrossFunds([fund], []);
    expect(rowsWithoutSecondArg).toEqual(rowsWithEmptyEntities);

    const totalsWithoutSecondArg = holdingsPortfolioTotals([fund]);
    const totalsWithEmptyEntities = holdingsPortfolioTotals([fund], []);
    expect(totalsWithoutSecondArg).toEqual(totalsWithEmptyEntities);

    expect(formatHolderCounts(2, 0)).toBe('2 funds');
    expect(formatHolderCounts(1, 0)).toBe('1 fund');
    expect(formatHolderCounts(0, 2)).toBe('2 entities');
    expect(formatHolderCounts(0, 1)).toBe('1 entity');
    expect(formatHolderCounts(2, 1)).toBe('2 funds and 1 entity');
    expect(formatHolderCounts(0, 0)).toBe('0 funds');

    const htmlWithoutInvestors = renderWithTooltip(
      React.createElement(MetricCards, { funds: [fund] }),
    );
    const htmlWithEmptyInvestors = renderWithTooltip(
      React.createElement(MetricCards, { funds: [fund], investors: [] }),
    );
    expect(htmlWithoutInvestors).toBe(htmlWithEmptyInvestors);
    expect(htmlWithoutInvestors).toContain('1 fund');
  });

  it('groups entity holdings by the actual holder entity when grouped by investor', () => {
    const fundHolding = makeHolding({ id: 'a1', cost: 100 });
    const entityHolding = makeHolding({ id: 'a2', cost: 200 });
    const fund = makeFund('f1', [fundHolding]);
    const entity = makeInvestor('e1', [entityHolding], 'Startech Group', 'Startech Ltd');

    const entityIdSet = new Set([entity.id]);
    const groups = sliceHoldingsByTxn(
      [fund],
      (t, h, f) => {
        if (entityIdSet.has(f.id)) return f.n;
        return t.holdingEntityId ?? getAssetEntity(h) ?? 'Unspecified';
      },
      (h, f) => {
        if (entityIdSet.has(f.id)) return [f.n];
        return [getAssetEntity(h) || 'Unspecified'];
      },
      [entity],
    );

    expect(groups.has('Startech Ltd')).toBe(true);
    expect(groups.get('Startech Ltd')![0].h).toBe(entityHolding);
    expect(groups.get('Startech Ltd')![0].cost).toBe(200);
    expect(groups.get('Startech Ltd')![0].holderNames).toEqual(['Startech Ltd (Startech Group)']);

    expect(groups.has('Unspecified')).toBe(true);
    expect(groups.get('Unspecified')![0].h).toBe(fundHolding);
    expect(groups.get('Unspecified')![0].cost).toBe(100);
  });

  it('by Fund Type and by Source of Fund groupings do not crash on entity holdings', () => {
    const entityHolding = makeHolding({ id: 'a2', cost: 200 });
    entityHolding.d = { fundingSource: 'General Account' };
    const entity = makeInvestor('e1', [entityHolding], null, 'Startech Ltd');

    // by Source of Fund
    const sourceGroups = sliceHoldingsByTxn(
      [],
      (t, h) => t.fundingSourceId ?? h.d?.fundingSource ?? 'Unspecified',
      (h) => [h.d?.fundingSource || 'Unspecified'],
      [entity],
    );
    expect(sourceGroups.has('General Account')).toBe(true);
    expect(sourceGroups.get('General Account')![0].cost).toBe(200);

    // Adapted fund preserves properties and allows safe access
    const adapted = entityToFundAdapter(entity);
    expect(adapted.id).toBe('e1');
    expect(adapted.n).toBe('Startech Ltd');
    expect(adapted.h).toEqual([entityHolding]);
  });

  it('MoneyBreakdown includes entities in both By fund/entity and By holding type views', () => {
    const fundHolding = makeHolding({ id: 'a1', cost: 100, fmv: 150 });
    const fund = makeFund('f1', [fundHolding]);
    fund.size = 200;
    fund.called = 100;
    const entityHolding = makeHolding({ id: 'a2', cost: 50, fmv: 75 });
    entityHolding.tp = 'Fund of funds';
    const entity = makeInvestor('e1', [entityHolding], 'Startech Group', 'Startech Ltd');

    // With both funds and entities
    const htmlBoth = renderWithTooltip(
      React.createElement(MoneyBreakdown, { funds: [fund], investors: [entity] }),
    );
    expect(htmlBoth).toContain('By fund / entity');
    expect(htmlBoth).toContain('Fund f1');
    expect(htmlBoth).toContain('Startech Ltd (Startech Group)');

    // With only entities (e.g. STARTECH workspace with no managed funds)
    const htmlEntitiesOnly = renderWithTooltip(
      React.createElement(MoneyBreakdown, { funds: [], investors: [entity] }),
    );
    expect(htmlEntitiesOnly).toContain('By entity');
    expect(htmlEntitiesOnly).toContain('Startech Ltd (Startech Group)');

    // With only funds (regression)
    const htmlFundsOnly = renderWithTooltip(
      React.createElement(MoneyBreakdown, { funds: [fund], investors: [] }),
    );
    expect(htmlFundsOnly).toContain('By fund');
    expect(htmlFundsOnly).not.toContain('By fund / entity');
    expect(htmlFundsOnly).not.toContain('By entity');
  });
});

describe('Phase A: Fund/Asset visibility gates: data + calc layer', () => {
  it('holdingsPortfolioTotals is byte-identical (including valuationCoverage) when displayOnly holdings are appended', () => {
    // 1. Setup base clean fixture
    const realHolding1 = makeHolding({
      id: 'a1',
      cost: 100,
      fmv: 150,
      real: 20,
      txns: [{ date: '2024-01-01', type: 'Buy', value: 100, fundId: 'f1' }],
    });
    realHolding1.positionId = 'pos-real-1';

    const realHolding2 = makeHolding({
      id: 'a2',
      cost: 200,
      fmv: 280,
      real: 40,
      txns: [{ date: '2024-01-01', type: 'Buy', value: 200, fundId: 'f1' }],
    });
    realHolding2.positionId = 'pos-real-2';

    const entityHolding = makeHolding({
      id: 'a3',
      cost: 50,
      fmv: 75,
      real: 10,
      txns: [{ date: '2024-01-01', type: 'Buy', value: 50, holdingEntityId: 'e1' }],
    });
    entityHolding.positionId = 'pos-entity-1';

    const baseFund = makeFund('f1', [realHolding1, realHolding2]);
    baseFund.size = 500;
    baseFund.called = 300;
    baseFund.fmv = 430;
    baseFund.real = 60;
    baseFund.hist = {
      committed: [500, 500, 500, 500],
      called: [300, 300, 300, 300],
      fmv: [400, 410, 420, 430],
      tvpi: [1.5, 1.55, 1.6, 1.63],
    };

    const baseEntity = makeInvestor('e1', [entityHolding]);

    // Baseline calculation
    const baseTotals = holdingsPortfolioTotals([baseFund], [baseEntity]);
    expect(baseTotals.valuationCoverage).toBe('complete');

    // 2. Create several displayOnly: true holdings
    // One with fmv: null (must NOT flip valuationCoverage to partial)
    const displayOnlyNullFmv: Holding = {
      id: 'a-orphan',
      n: 'Orphan Asset',
      tp: 'Equity',
      dt: '2024-01-01',
      cost: 0,
      fmv: null,
      real: 0,
      moic: null,
      st: 'Unlinked',
      displayOnly: true,
      disclosure: 'no_holder',
    };

    // One with a positionId that duplicates a real row's (must NOT suppress the real row)
    const displayOnlyDupPos: Holding = {
      id: 'a-dup-pos',
      n: 'Dup Pos Asset',
      tp: 'Equity',
      dt: '2024-01-01',
      cost: 999,
      fmv: null,
      real: 888,
      moic: null,
      st: 'Unlinked',
      positionId: 'pos-real-1',
      positionIds: ['pos-real-1'],
      displayOnly: true,
      disclosure: 'unresolved_target',
    };

    // An external/liquidated synthetic fund with displayOnly: true
    const displayOnlyFund: Fund = {
      id: 'f-ext',
      n: 'External Fund',
      v: 2024,
      size: 9999,
      called: 8888,
      calledPct: 50,
      fmv: null,
      real: 7777,
      dpi: 1,
      tvpi: null,
      irr: 0,
      st: 'Investing',
      displayOnly: true,
      disclosure: 'external_fund',
      h: [
        {
          id: 'a-ext-h',
          n: 'Ext Holding',
          tp: 'Equity',
          dt: '2024-01-01',
          cost: 500,
          fmv: null,
          real: 100,
          moic: null,
          st: 'Active',
          displayOnly: true,
          disclosure: 'external_fund',
        },
      ],
    };

    // 3. Append displayOnly holdings to fund and to entity.holdings, and add displayOnly fund
    const taintedFund: Fund = {
      ...baseFund,
      h: [displayOnlyDupPos, ...baseFund.h], // placed before real holding to test positionId dedup immunity
    };

    const taintedEntity: Investor = {
      ...baseEntity,
      holdings: [...(baseEntity.holdings ?? []), displayOnlyNullFmv],
    };

    // Calculation with displayOnly rows injected
    const taintedTotals = holdingsPortfolioTotals([taintedFund, displayOnlyFund], [taintedEntity]);

    // 4. Assert deep equality of every field, especially valuationCoverage
    expect(taintedTotals).toEqual(baseTotals);
    expect(taintedTotals.valuationCoverage).toBe('complete');
  });

  it('portfolioTotals skips displayOnly funds and displayOnly holdings', () => {
    const normalHolding = makeHolding({ id: 'a1', cost: 100, fmv: 150 });
    const normalFund = makeFund('f1', [normalHolding]);
    normalFund.size = 200;
    normalFund.called = 100;
    normalFund.fmv = 150;
    normalFund.real = 20;

    const baseTotals = portfolioTotals([normalFund]);

    const displayOnlyFund: Fund = {
      ...makeFund('f-display', []),
      size: 1000,
      called: 500,
      fmv: null,
      real: 200,
      displayOnly: true,
      disclosure: 'liquidated_fund',
    };

    const taintedFund: Fund = {
      ...normalFund,
      h: [
        ...normalFund.h,
        {
          id: 'a-discl',
          n: 'Disclosure Holding',
          tp: 'Equity',
          dt: '',
          cost: 500,
          fmv: null,
          real: 0,
          moic: null,
          st: 'Unlinked',
          displayOnly: true,
          disclosure: 'unresolved_target',
        },
      ],
    };

    const taintedTotals = portfolioTotals([taintedFund, displayOnlyFund]);
    expect(taintedTotals).toEqual(baseTotals);
    expect(taintedTotals.valuationCoverage).toBe('complete');
  });

  it('holdingBreakdown skips displayOnly holdings', () => {
    const normalHolding1 = makeHolding({ id: 'a1' });
    const normalHolding2 = makeHolding({ id: 'a2' });
    normalHolding2.tp = 'Fund of funds';

    const displayOnlyHolding: Holding = {
      id: 'a3',
      n: 'Unassigned Asset',
      tp: 'Cash',
      dt: '',
      cost: 0,
      fmv: null,
      real: 0,
      moic: null,
      st: 'Unlinked',
      displayOnly: true,
      disclosure: 'no_holder',
    };

    const baseBreakdown = holdingBreakdown([normalHolding1, normalHolding2]);
    const withDisplayOnly = holdingBreakdown([normalHolding1, normalHolding2, displayOnlyHolding]);

    expect(withDisplayOnly).toBe(baseBreakdown);
    expect(withDisplayOnly).not.toContain('Cash');
  });

  it('sumHist skips displayOnly funds', () => {
    const f1 = makeFund('f1', []);
    f1.hist = {
      committed: [100, 100, 100, 100],
      called: [50, 50, 50, 50],
      fmv: [60, 70, 80, 90],
    };
    const fExt: Fund = {
      ...makeFund('f-ext', []),
      displayOnly: true,
      disclosure: 'external_fund',
      hist: {
        committed: [500, 500, 500, 500],
        called: [250, 250, 250, 250],
        fmv: [null, null, null, null],
      },
    };

    expect(sumHist([f1, fExt], 'committed')).toEqual([100, 100, 100, 100]);
    expect(sumHist([f1, fExt], 'fmv')).toEqual([60, 70, 80, 90]);
  });

  it('mergeHoldingsAcrossFunds keeps displayOnly holding as standalone row and never merges with real asset', () => {
    const realHolding = makeHolding({ id: 'shared-asset-id', cost: 100, fmv: 120 });
    const fund = makeFund('f1', [realHolding]);

    // A displayOnly holding with the SAME id
    const displayOnlyHolding: Holding = {
      id: 'shared-asset-id',
      n: 'Display Only Holding',
      tp: 'Equity',
      dt: '2024-01-01',
      cost: 0,
      fmv: null,
      real: 0,
      moic: null,
      st: 'Unlinked',
      displayOnly: true,
      disclosure: 'unresolved_target',
    };
    const entity = makeInvestor('e1', [displayOnlyHolding]);

    const rows = mergeHoldingsAcrossFunds([fund], [entity]);
    // Must NOT merge into 1 row! Must produce 2 distinct rows.
    expect(rows).toHaveLength(2);

    const realRow = rows.find((r) => !r.h.displayOnly);
    expect(realRow).toBeDefined();
    expect(realRow!.h.cost).toBe(100);
    expect(realRow!.h.fmv).toBe(120);

    const displayOnlyRow = rows.find((r) => r.h.displayOnly);
    expect(displayOnlyRow).toBeDefined();
    expect(displayOnlyRow!.h.displayOnly).toBe(true);
    expect(displayOnlyRow!.h.disclosure).toBe('unresolved_target');
    expect(displayOnlyRow!.h.cost).toBe(0);
    expect(displayOnlyRow!.h.fmv).toBeNull();
  });
});

describe('Phase 3 Task 2: Historical cutoff - historical calculations must not use future data', () => {
  describe('selectEligibleMark', () => {
    it('selects the latest mark on or before effectiveAsOf', () => {
      const marks: Quarter[] = [
        { q: 'Q1', asOfDate: '2024-03-31', mv: 100 },
        { q: 'Q2', asOfDate: '2024-06-30', mv: 150 },
        { q: 'Q4', asOfDate: '2024-12-31', mv: 200 },
      ];
      const selected = selectEligibleMark(marks, '2024-06-30');
      expect(selected).not.toBeNull();
      expect(selected!.asOfDate).toBe('2024-06-30');
      expect(selected!.mv).toBe(150);
    });

    it('ignores future marks and selects prior eligible mark', () => {
      const marks: Quarter[] = [
        { q: 'Q1', asOfDate: '2024-03-31', mv: 100 },
        { q: 'Q4', asOfDate: '2024-12-31', mv: 200 },
      ];
      const selected = selectEligibleMark(marks, '2024-06-30');
      expect(selected).not.toBeNull();
      expect(selected!.asOfDate).toBe('2024-03-31');
      expect(selected!.mv).toBe(100);
    });

    it('returns null when cutoff is before every mark', () => {
      const marks: Quarter[] = [
        { q: 'Q1', asOfDate: '2024-03-31', mv: 100 },
        { q: 'Q4', asOfDate: '2024-12-31', mv: 200 },
      ];
      const selected = selectEligibleMark(marks, '2024-01-31');
      expect(selected).toBeNull();
    });

    it('treats undated marks as ineligible under a historical cutoff', () => {
      const marks: Quarter[] = [
        { q: 'Q1', mv: 100 },
        { q: 'Q2', asOfDate: '2024-06-30', mv: 150 },
      ];
      // Cutoff before Q2
      const selected = selectEligibleMark(marks, '2024-03-31');
      // Undated Q1 cannot be assumed eligible; Q2 is future. Result must be null.
      expect(selected).toBeNull();
    });

    it('returns null when all marks are undated under a cutoff', () => {
      const marks: Quarter[] = [
        { q: 'Q1', mv: 100 },
        { q: 'Q2', mv: 150 },
      ];
      expect(selectEligibleMark(marks, '2024-06-30')).toBeNull();
    });

    it('selects latest by date even when marks are out of array order (simulating manual edit appends)', () => {
      // Out of order: Q4 is first, Q1 second, Q3 last
      const marks: Quarter[] = [
        { q: 'Q4', asOfDate: '2024-12-31', mv: 200 },
        { q: 'Q1', asOfDate: '2024-03-31', mv: 100 },
        { q: 'Q3', asOfDate: '2024-09-30', mv: 180 },
      ];
      // With cutoff as of 2024-06-30, Q1 must be selected
      const selectedCutoff = selectEligibleMark(marks, '2024-06-30');
      expect(selectedCutoff).not.toBeNull();
      expect(selectedCutoff!.asOfDate).toBe('2024-03-31');
      expect(selectedCutoff!.mv).toBe(100);

      // Without cutoff, latest mark by date (Q4: 2024-12-31) must be selected, NOT the last array element (Q3)
      const selectedNoCutoff = selectEligibleMark(marks);
      expect(selectedNoCutoff).not.toBeNull();
      expect(selectedNoCutoff!.asOfDate).toBe('2024-12-31');
      expect(selectedNoCutoff!.mv).toBe(200);
    });

    it('preserves array last element when all marks are undated and no cutoff is supplied', () => {
      const marks: Quarter[] = [
        { q: 'Q1', mv: 100 },
        { q: 'Q2', mv: 150 },
      ];
      const selected = selectEligibleMark(marks);
      expect(selected).not.toBeNull();
      expect(selected!.q).toBe('Q2');
      expect(selected!.mv).toBe(150);
    });

    it('returns null for empty or undefined array', () => {
      expect(selectEligibleMark([])).toBeNull();
      expect(selectEligibleMark(undefined)).toBeNull();
      expect(selectEligibleMark([], '2024-06-30')).toBeNull();
    });
  });

  describe('computeInv historical cutoff', () => {
    it('uses Q1 value, price, and terminal date when computing as of Q2 with Q1 and Q4 present (never touches Q4)', () => {
      const holding = makeHolding({
        id: 'h-cutoff-inv',
        cost: 100,
        fmv: 200,
        txns: [{ date: '2024-01-15', type: 'Buy', value: 100, shares: 1000 }],
      });
      holding.inv!.quarterly = [
        { q: 'Q1', asOfDate: '2024-03-31', mv: 120, pps: 0.12 },
        { q: 'Q4', asOfDate: '2024-12-31', mv: 200, pps: 0.20 },
      ];

      const metrics = computeInv(holding, '2024-06-30');
      expect(metrics).not.toBeNull();

      // Must explicitly use Q1 terminal date, NOT Q4 date and NOT today
      expect(metrics!.terminalDate).toBe('2024-03-31');
      expect(metrics!.terminalDate).not.toBe('2024-12-31');

      // Valuation metrics must reflect Q1, never Q4
      expect(metrics!.unrealizedValue).toBe(120);
      expect(metrics!.curPrice).toBe(0.12);
      expect(metrics!.totalValueGross).toBe(120);
      expect(metrics!.grossMOIC).toBe(1.2);

      // IRR must be calculated using Q1 terminal observation
      expect(metrics!.grossIRR).not.toBeNull();
      expect(metrics!.grossIRR!.status).toBe('calculated');
      expect(metrics!.grossIRR!.value).toBeGreaterThan(0);
    });

    it('returns metrics unavailable when computing as of a date before every mark (no current-price or today fallback)', () => {
      const holding = makeHolding({
        id: 'h-before-marks',
        cost: 100,
        fmv: 250, // current FMV
        txns: [{ date: '2024-01-15', type: 'Buy', value: 100, shares: 1000 }],
      });
      holding.inv!._cur = 0.25; // current price
      holding.inv!.quarterly = [
        { q: 'Q1', asOfDate: '2024-03-31', mv: 120, pps: 0.12 },
        { q: 'Q4', asOfDate: '2024-12-31', mv: 200, pps: 0.20 },
      ];

      const metrics = computeInv(holding, '2024-02-15');
      expect(metrics).not.toBeNull();

      // Must NOT fall back to inv._cur, h.fmv, or today's date
      expect(metrics!.curPrice).toBeNull();
      expect(metrics!.unrealizedValue).toBeNull();
      expect(metrics!.totalValueGross).toBeNull();
      expect(metrics!.grossMOIC).toBeNull();
      expect(metrics!.netMOIC).toBeNull();
      expect(metrics!.grossIRR).toBeNull();
      expect(metrics!.terminalDate).toBeNull();
    });

    it('returns metrics unavailable (not zero) when no marks exist under a cutoff', () => {
      const holding = makeHolding({
        id: 'h-no-marks-cutoff',
        cost: 100,
        fmv: 250,
        txns: [{ date: '2024-01-15', type: 'Buy', value: 100, shares: 1000 }],
      });
      holding.inv!._cur = 0.25;
      holding.inv!.quarterly = [];

      const metrics = computeInv(holding, '2024-06-30');
      expect(metrics).not.toBeNull();
      expect(metrics!.curPrice).toBeNull();
      expect(metrics!.unrealizedValue).toBeNull();
      expect(metrics!.totalValueGross).toBeNull();
      expect(metrics!.grossMOIC).toBeNull();
      expect(metrics!.grossIRR).toBeNull();
      expect(metrics!.terminalDate).toBeNull();
    });

    it('computes realized return without terminal mark for a fully exited position as of historical date', () => {
      const holding = makeHolding({
        id: 'h-exited-inv',
        cost: 100,
        fmv: 200,
        txns: [
          { date: '2024-01-15', type: 'Buy', value: 100, shares: 1000 },
          { date: '2024-05-15', type: 'Sell', value: 150, shares: 1000 },
        ],
      });
      holding.inv!.quarterly = [
        { q: 'Q1', asOfDate: '2024-03-31', mv: 120, pps: 0.12 },
        { q: 'Q4', asOfDate: '2024-12-31', mv: 200, pps: 0.20 },
      ];

      // Computed as of 2024-06-30 (after the exit on 2024-05-15)
      const afterExit = computeInv(holding, '2024-06-30');
      expect(afterExit).not.toBeNull();
      expect(afterExit!.sharesAcquired).toBe(1000);
      expect(afterExit!.sharesDisposed).toBe(1000);
      expect(afterExit!.sharesHeld).toBe(0);
      expect(afterExit!.investedCapital).toBe(100);
      expect(afterExit!.realizedProceedsGross).toBe(150);

      // Unrealized value must be 0 (no remaining shares), NOT Q1 or Q4 mark
      expect(afterExit!.unrealizedValue).toBe(0);
      expect(afterExit!.totalValueGross).toBe(150);
      expect(afterExit!.grossMOIC).toBe(1.5);
      expect(afterExit!.dpi).toBe(1.5);

      // Gross IRR is calculated from the closed trade cash flows (-100, +150)
      expect(afterExit!.grossIRR).not.toBeNull();
      expect(afterExit!.grossIRR!.status).toBe('calculated');
      expect(afterExit!.grossIRR!.value).toBeGreaterThan(0);

      // Computed as of 2024-04-15 (before the exit on 2024-05-15)
      const beforeExit = computeInv(holding, '2024-04-15');
      expect(beforeExit).not.toBeNull();
      expect(beforeExit!.sharesHeld).toBe(1000);
      expect(beforeExit!.unrealizedValue).toBe(120); // uses Q1 mark
      expect(beforeExit!.terminalDate).toBe('2024-03-31');
      expect(beforeExit!.grossMOIC).toBe(1.2);
    });

    it('produces identical results to today when no cutoff is supplied (regression guard)', () => {
      const holding = makeHolding({
        id: 'h-reg-guard',
        cost: 100,
        fmv: 200,
        txns: [{ date: '2024-01-15', type: 'Buy', value: 100, shares: 1000 }],
      });
      holding.inv!.quarterly = [
        { q: 'Q1', asOfDate: '2024-03-31', mv: 120, pps: 0.12 },
        { q: 'Q4', asOfDate: '2024-12-31', mv: 200, pps: 0.20 },
      ];

      const metrics = computeInv(holding);
      expect(metrics).not.toBeNull();
      // Without cutoff, latest mark (Q4) wins
      expect(metrics!.unrealizedValue).toBe(200);
      expect(metrics!.curPrice).toBe(0.20);
      expect(metrics!.terminalDate).toBe('2024-12-31');
      expect(metrics!.grossMOIC).toBe(2.0);
    });

    // Codex-added during review: the no-cutoff branch also gained a fully-exited rule
    // (unrealizedValue = 0 when every share is disposed) but had coverage only for the
    // historical-cutoff case. This pins the present-day behaviour so it cannot drift back
    // to reporting a stale mark as unrealized value on a closed position.
    it('reports zero unrealized value for a fully exited position with no cutoff supplied', () => {
      const holding = makeHolding({
        id: 'h-exited-no-cutoff',
        cost: 100,
        fmv: 200,
        txns: [
          { date: '2024-01-15', type: 'Buy', value: 100, shares: 1000 },
          { date: '2024-05-15', type: 'Sell', value: 150, shares: 1000 },
        ],
      });
      holding.inv!.quarterly = [
        { q: 'Q1', asOfDate: '2024-03-31', mv: 120, pps: 0.12 },
        { q: 'Q4', asOfDate: '2024-12-31', mv: 200, pps: 0.20 },
      ];

      const m = computeInv(holding);
      expect(m).not.toBeNull();
      expect(m!.sharesHeld).toBe(0);
      // Every share is disposed, so nothing is still held: not the Q4 mark (200), not h.fmv (200).
      expect(m!.unrealizedValue).toBe(0);
      expect(m!.totalValueGross).toBe(150);
      expect(m!.dpi).toBe(1.5);
    });

    it('correctly selects mark by date when quarterly array is out of chronological order', () => {
      const holding = makeHolding({
        id: 'h-out-of-order',
        cost: 100,
        fmv: 180,
        txns: [{ date: '2024-01-15', type: 'Buy', value: 100, shares: 1000 }],
      });
      // Out of order: Q4 first, Q1 second, Q3 last (array length-1 is Q3)
      holding.inv!.quarterly = [
        { q: 'Q4', asOfDate: '2024-12-31', mv: 200, pps: 0.20 },
        { q: 'Q1', asOfDate: '2024-03-31', mv: 120, pps: 0.12 },
        { q: 'Q3', asOfDate: '2024-09-30', mv: 180, pps: 0.18 },
      ];

      // As of 2024-06-30: must select Q1 (2024-03-31), NOT the last element Q3
      const metricsCutoff = computeInv(holding, '2024-06-30');
      expect(metricsCutoff!.terminalDate).toBe('2024-03-31');
      expect(metricsCutoff!.unrealizedValue).toBe(120);

      // Without cutoff: must select Q4 (2024-12-31) by date, NOT the last element Q3
      const metricsNoCutoff = computeInv(holding);
      expect(metricsNoCutoff!.terminalDate).toBe('2024-12-31');
      expect(metricsNoCutoff!.unrealizedValue).toBe(200);
    });

    it('treats undated marks as ineligible under cutoff and preserves them when no cutoff is supplied', () => {
      const holding = makeHolding({
        id: 'h-undated',
        cost: 100,
        fmv: 150,
        txns: [{ date: '2024-01-15', type: 'Buy', value: 100, shares: 1000 }],
      });
      holding.inv!.quarterly = [{ q: 'Legacy', mv: 150, pps: 0.15 }];

      // With cutoff: undated mark is ineligible
      const metricsWithCutoff = computeInv(holding, '2024-06-30');
      expect(metricsWithCutoff!.unrealizedValue).toBeNull();
      expect(metricsWithCutoff!.curPrice).toBeNull();
      expect(metricsWithCutoff!.terminalDate).toBeNull();

      // Without cutoff: undated mark is preserved (today's behavior)
      const metricsNoCutoff = computeInv(holding);
      expect(metricsNoCutoff!.unrealizedValue).toBe(150);
      expect(metricsNoCutoff!.curPrice).toBe(0.15);
    });
  });

  describe('computeFoF historical cutoff', () => {
    it('uses Q1 value and terminal date when computing as of Q2 with Q1 and Q4 present (never touches Q4)', () => {
      const fofHolding: Holding = {
        id: 'h-cutoff-fof',
        n: 'Growth Fund IV',
        tp: 'Fund of funds',
        dt: '2024-01-15',
        cost: 100,
        fmv: 200,
        real: 0,
        moic: 2.0,
        st: 'Active',
        inv: {
          txns: [{ date: '2024-01-15', type: 'Buy', value: 100 }],
          quarterly: [
            { q: 'Q1', asOfDate: '2024-03-31', mv: 120 },
            { q: 'Q4', asOfDate: '2024-12-31', mv: 200 },
          ],
        },
      };

      const metrics = computeFoF(fofHolding, '2024-06-30');
      expect(metrics).not.toBeNull();

      // Must explicitly use Q1 terminal date, NOT Q4 date and NOT today
      expect(metrics!.terminalDate).toBe('2024-03-31');
      expect(metrics!.terminalDate).not.toBe('2024-12-31');

      // Market value and MOIC must reflect Q1, never Q4
      expect(metrics!.marketValue).toBe(120);
      expect(metrics!.moic).toBe(1.2);

      // XIRR must be calculated with Q1 terminal date
      expect(metrics!.xirr).not.toBeNull();
      expect(metrics!.xirr!.status).toBe('calculated');
      expect(metrics!.xirr!.value).toBeGreaterThan(0);
    });

    it('returns metrics unavailable when computing as of a date before every mark (no fmv or today fallback)', () => {
      const fofHolding: Holding = {
        id: 'h-fof-before-marks',
        n: 'Growth Fund IV',
        tp: 'Fund of funds',
        dt: '2024-01-15',
        cost: 100,
        fmv: 250, // current FMV
        real: 0,
        moic: 2.5,
        st: 'Active',
        inv: {
          txns: [{ date: '2024-01-15', type: 'Buy', value: 100 }],
          quarterly: [
            { q: 'Q1', asOfDate: '2024-03-31', mv: 120 },
            { q: 'Q4', asOfDate: '2024-12-31', mv: 200 },
          ],
        },
      };

      const metrics = computeFoF(fofHolding, '2024-02-15');
      expect(metrics).not.toBeNull();

      // Must NOT fall back to h.fmv or today's date
      expect(metrics!.marketValue).toBeNull();
      expect(metrics!.moic).toBeNull();
      expect(metrics!.xirr).toBeNull();
      expect(metrics!.terminalDate).toBeNull();
    });

    it('returns metrics unavailable (not zero) when no marks exist under a cutoff', () => {
      const fofHolding: Holding = {
        id: 'h-fof-no-marks-cutoff',
        n: 'Growth Fund IV',
        tp: 'Fund of funds',
        dt: '2024-01-15',
        cost: 100,
        fmv: 250,
        real: 0,
        moic: 2.5,
        st: 'Active',
        inv: {
          txns: [{ date: '2024-01-15', type: 'Buy', value: 100 }],
          quarterly: [],
        },
      };

      const metrics = computeFoF(fofHolding, '2024-06-30');
      expect(metrics).not.toBeNull();
      expect(metrics!.marketValue).toBeNull();
      expect(metrics!.moic).toBeNull();
      expect(metrics!.xirr).toBeNull();
      expect(metrics!.terminalDate).toBeNull();
    });

    it('computes realized return for fully liquidated FoF position as of historical date', () => {
      const fofHolding: Holding = {
        id: 'h-fof-liquidated',
        n: 'Growth Fund IV',
        tp: 'Fund of funds',
        dt: '2024-01-15',
        cost: 100,
        fmv: 0,
        real: 150,
        moic: 1.5,
        st: 'Active',
        inv: {
          txns: [
            { date: '2024-01-15', type: 'Buy', value: 100 },
            { date: '2024-05-15', type: 'Sell', value: 150 },
          ],
          quarterly: [
            { q: 'Q1', asOfDate: '2024-03-31', mv: 120 },
            { q: 'Q2', asOfDate: '2024-06-30', mv: 0 }, // exit mark
            { q: 'Q4', asOfDate: '2024-12-31', mv: 50 },
          ],
        },
      };

      const metrics = computeFoF(fofHolding, '2024-07-15');
      expect(metrics).not.toBeNull();
      expect(metrics!.totalCalled).toBe(100);
      expect(metrics!.totalDist).toBe(150);
      expect(metrics!.marketValue).toBe(0);
      expect(metrics!.moic).toBe(1.5);
      expect(metrics!.dpi).toBe(1.5);

      // XIRR calculated from calls and distributions
      expect(metrics!.xirr).not.toBeNull();
      expect(metrics!.xirr!.status).toBe('calculated');
      expect(metrics!.xirr!.value).toBeGreaterThan(0);
    });

    it('produces identical results to today when no cutoff is supplied (regression guard)', () => {
      const fofHolding: Holding = {
        id: 'h-fof-reg-guard',
        n: 'Growth Fund IV',
        tp: 'Fund of funds',
        dt: '2024-01-15',
        cost: 100,
        fmv: 200,
        real: 0,
        moic: 2.0,
        st: 'Active',
        inv: {
          txns: [{ date: '2024-01-15', type: 'Buy', value: 100 }],
          quarterly: [
            { q: 'Q1', asOfDate: '2024-03-31', mv: 120 },
            { q: 'Q4', asOfDate: '2024-12-31', mv: 200 },
          ],
        },
      };

      const metrics = computeFoF(fofHolding);
      expect(metrics).not.toBeNull();
      expect(metrics!.marketValue).toBe(200);
      expect(metrics!.terminalDate).toBe('2024-12-31');
      expect(metrics!.moic).toBe(2.0);
    });

    it('correctly selects mark by date when quarterly array is out of chronological order in computeFoF', () => {
      const fofHolding: Holding = {
        id: 'h-fof-out-of-order',
        n: 'Growth Fund IV',
        tp: 'Fund of funds',
        dt: '2024-01-15',
        cost: 100,
        fmv: 180,
        real: 0,
        moic: 1.8,
        st: 'Active',
        inv: {
          txns: [{ date: '2024-01-15', type: 'Buy', value: 100 }],
          quarterly: [
            { q: 'Q4', asOfDate: '2024-12-31', mv: 200 },
            { q: 'Q1', asOfDate: '2024-03-31', mv: 120 },
            { q: 'Q3', asOfDate: '2024-09-30', mv: 180 },
          ],
        },
      };

      // As of 2024-06-30: must select Q1 (2024-03-31), NOT the last element Q3
      const metricsCutoff = computeFoF(fofHolding, '2024-06-30');
      expect(metricsCutoff!.terminalDate).toBe('2024-03-31');
      expect(metricsCutoff!.marketValue).toBe(120);

      // Without cutoff: must select Q4 (2024-12-31) by date, NOT the last element Q3
      const metricsNoCutoff = computeFoF(fofHolding);
      expect(metricsNoCutoff!.terminalDate).toBe('2024-12-31');
      expect(metricsNoCutoff!.marketValue).toBe(200);
    });

    it('treats undated marks as ineligible under cutoff and preserves them when no cutoff is supplied in computeFoF', () => {
      const fofHolding: Holding = {
        id: 'h-fof-undated',
        n: 'Growth Fund IV',
        tp: 'Fund of funds',
        dt: '2024-01-15',
        cost: 100,
        fmv: 150,
        real: 0,
        moic: 1.5,
        st: 'Active',
        inv: {
          txns: [{ date: '2024-01-15', type: 'Buy', value: 100 }],
          quarterly: [{ q: 'Legacy', mv: 150 }],
        },
      };

      // With cutoff: undated mark is ineligible
      const metricsWithCutoff = computeFoF(fofHolding, '2024-06-30');
      expect(metricsWithCutoff!.marketValue).toBeNull();
      expect(metricsWithCutoff!.moic).toBeNull();
      expect(metricsWithCutoff!.terminalDate).toBeNull();

      // Without cutoff: undated mark is preserved (today's behavior)
      const metricsNoCutoff = computeFoF(fofHolding);
      expect(metricsNoCutoff!.marketValue).toBe(150);
    });
  });

  describe('signed economic types and metrics (Phase 3 Task 3)', () => {
    it('implements literal acceptance scenario: buy 100, actual expense 5, sell 120 gives net cash gain 15 with no remaining position value, and estimated expense of 5 changes nothing (Direct)', () => {
      const holdingWithEstimate: Holding = {
        id: 'h-acceptance-direct',
        n: 'Acme Corp',
        tp: 'Direct Investments',
        dt: '2024-01-01',
        cost: 100,
        fmv: 0,
        real: 120,
        moic: 1.15,
        st: 'Exited',
        inv: {
          txns: [
            { date: '2024-01-01', type: 'Buy', value: 100, shares: 1000 },
            { date: '2024-02-01', type: 'Other', entryType: 'expense', value: 5, rawCashDelta: '-5000000' },
            { date: '2024-02-15', type: 'Other', entryType: 'expense', value: 5, isEstimated: true, notes: 'Estimated CIT' },
            { date: '2024-03-01', type: 'Sell', value: 120, shares: 1000 },
          ],
          quarterly: [],
        },
      };

      const metrics = computeInv(holdingWithEstimate);
      expect(metrics).not.toBeNull();
      // Literal scenario numbers:
      expect(metrics!.investedCapital).toBe(100);
      expect(metrics!.realizedProceedsGross).toBe(120);
      expect(metrics!.otherVal).toBe(-5); // actual expense reduces, estimated is excluded
      expect(metrics!.sharesAcquired).toBe(1000);
      expect(metrics!.sharesDisposed).toBe(1000);
      expect(metrics!.sharesHeld).toBe(0); // no remaining shares
      expect(metrics!.unrealizedValue).toBe(0); // no remaining position value
      expect(metrics!.totalValueGross).toBe(115); // 120 - 5 + 0
      expect(metrics!.totalGrossGain).toBe(15); // Net cash gain 15!

      // Baseline holding without the estimated expense
      const holdingWithoutEstimate: Holding = {
        ...holdingWithEstimate,
        inv: {
          ...holdingWithEstimate.inv!,
          txns: [
            { date: '2024-01-01', type: 'Buy', value: 100, shares: 1000 },
            { date: '2024-02-01', type: 'Other', entryType: 'expense', value: 5, rawCashDelta: '-5000000' },
            { date: '2024-03-01', type: 'Sell', value: 120, shares: 1000 },
          ],
        },
      };
      const metricsWithout = computeInv(holdingWithoutEstimate);
      // An estimated expense of 5 changes nothing:
      expect(metrics!.totalGrossGain).toBe(metricsWithout!.totalGrossGain);
      expect(metrics!.totalValueGross).toBe(metricsWithout!.totalValueGross);
      expect(metrics!.otherVal).toBe(metricsWithout!.otherVal);
      expect(metrics!.grossIRR).toEqual(metricsWithout!.grossIRR);
    });

    it('implements literal acceptance scenario in FoF: buy 100, actual expense 5, sell 120 gives net cash gain 15, estimated expense of 5 changes nothing', () => {
      const fofHolding: Holding = {
        id: 'h-acceptance-fof',
        n: 'Venture Fund I',
        tp: 'Fund of funds',
        dt: '2024-01-01',
        cost: 100,
        fmv: 0,
        real: 120,
        moic: 1.15,
        st: 'Exited',
        inv: {
          txns: [
            { date: '2024-01-01', type: 'Buy', value: 100 },
            { date: '2024-02-01', type: 'Other', entryType: 'expense', value: 5, rawCashDelta: '-5000000' },
            { date: '2024-02-15', type: 'Other', entryType: 'expense', value: 5, isEstimated: true, notes: 'Conservative Estimated CIT' },
            { date: '2024-03-01', type: 'Sell', value: 120 },
          ],
          quarterly: [],
        },
      };

      const metrics = computeFoF(fofHolding);
      expect(metrics).not.toBeNull();
      expect(metrics!.totalCalled).toBe(100);
      expect(metrics!.costInv).toBe(100);
      expect(metrics!.totalDist).toBe(120);
      expect(metrics!.totalOther).toBe(-5);
      expect(metrics!.netDist).toBe(115);
      expect(metrics!.marketValue).toBe(0);
      // Net cash gain = netDist - costInv = 115 - 100 = 15
      expect(metrics!.netDist - metrics!.costInv).toBe(15);
      expect(metrics!.moic).toBe(1.15);
      expect(metrics!.dpi).toBe(1.15);

      // Without estimated expense:
      const fofWithout = computeFoF({
        ...fofHolding,
        inv: {
          ...fofHolding.inv!,
          txns: [
            { date: '2024-01-01', type: 'Buy', value: 100 },
            { date: '2024-02-01', type: 'Other', entryType: 'expense', value: 5, rawCashDelta: '-5000000' },
            { date: '2024-03-01', type: 'Sell', value: 120 },
          ],
        },
      });
      expect(metrics!.netDist).toBe(fofWithout!.netDist);
      expect(metrics!.totalOther).toBe(fofWithout!.totalOther);
      expect(metrics!.xirr).toEqual(fofWithout!.xirr);
    });

    it('covers partial exits with expenses', () => {
      const holding: Holding = {
        id: 'h-partial-exit',
        n: 'Beta Corp',
        tp: 'Direct Investments',
        dt: '2024-01-01',
        cost: 100,
        fmv: 60,
        real: 60,
        moic: 1.15,
        st: 'Active',
        inv: {
          txns: [
            { date: '2024-01-01', type: 'Buy', value: 100, shares: 1000 },
            { date: '2024-02-01', type: 'Other', entryType: 'expense', value: 5, rawCashDelta: '-5000000' },
            { date: '2024-03-01', type: 'Sell', value: 60, shares: 500 },
          ],
          quarterly: [
            { q: 'Q1', asOfDate: '2024-03-31', mv: 60, pps: 0.12 },
          ],
        },
      };

      const metrics = computeInv(holding);
      expect(metrics).not.toBeNull();
      expect(metrics!.investedCapital).toBe(100);
      expect(metrics!.realizedProceedsGross).toBe(60);
      expect(metrics!.sharesAcquired).toBe(1000);
      expect(metrics!.sharesDisposed).toBe(500);
      expect(metrics!.sharesHeld).toBe(500);
      expect(metrics!.otherVal).toBe(-5);
      expect(metrics!.unrealizedValue).toBe(60);
      expect(metrics!.totalValueGross).toBe(115); // 60 (realized) - 5 (expense) + 60 (unrealized)
      expect(metrics!.totalGrossGain).toBe(15);
    });

    it('valuation adjustments never appear as cash flows', () => {
      const directHolding: Holding = {
        id: 'h-adj-direct',
        n: 'Delta Inc',
        tp: 'Direct Investments',
        dt: '2024-01-01',
        cost: 100,
        fmv: 110,
        real: 0,
        moic: 1.1,
        st: 'Active',
        inv: {
          txns: [
            { date: '2024-01-01', type: 'Buy', value: 100, shares: 1000 },
            {
              date: '2024-02-01',
              type: 'Other',
              entryType: 'adjustment',
              value: 10,
              rawValuationDelta: '10000000',
              rawCashDelta: '0',
            },
            {
              date: '2024-03-01',
              type: 'Other',
              entryType: 'adjustment',
              value: 20,
              rawValuationDelta: '-20000000',
              rawCashDelta: '0',
            },
          ],
          quarterly: [{ q: 'Q1', asOfDate: '2024-03-31', mv: 110 }],
        },
      };

      const directMetrics = computeInv(directHolding);
      expect(directMetrics!.otherVal).toBe(0); // adjustments produce 0 cash flow
      expect(directMetrics!.totalValueGross).toBe(110); // realized 0 + other 0 + unrealized 110

      const fofHolding: Holding = {
        id: 'h-adj-fof',
        n: 'Delta FoF',
        tp: 'Fund of funds',
        dt: '2024-01-01',
        cost: 100,
        fmv: 110,
        real: 0,
        moic: 1.1,
        st: 'Active',
        inv: {
          txns: [
            { date: '2024-01-01', type: 'Buy', value: 100 },
            {
              date: '2024-02-01',
              type: 'Other',
              entryType: 'adjustment',
              value: 10,
              rawValuationDelta: '10000000',
              rawCashDelta: '0',
            },
          ],
          quarterly: [{ q: 'Q1', asOfDate: '2024-03-31', mv: 110 }],
        },
      };

      const fofMetrics = computeFoF(fofHolding);
      expect(fofMetrics!.totalOther).toBe(0);
      expect(fofMetrics!.othersCount).toBe(0); // adjustment excluded from others count
    });

    it('handles reversal timing: expense active before reversal date, excluded on and after reversal date', () => {
      const holding: Holding = {
        id: 'h-rev-timing',
        n: 'Reversal Holding',
        tp: 'Direct Investments',
        dt: '2024-01-01',
        cost: 100,
        fmv: 120,
        real: 0,
        moic: 1.2,
        st: 'Active',
        inv: {
          txns: [
            { date: '2024-01-01', type: 'Buy', value: 100, shares: 1000 },
            {
              date: '2024-02-01',
              type: 'Other',
              entryType: 'expense',
              value: 5,
              rawCashDelta: '-5000000',
              isReversedOriginal: true,
              reversalDate: '2024-03-01',
            },
            {
              date: '2024-03-01',
              type: 'Other',
              entryType: 'expense',
              value: -5,
              rawCashDelta: '5000000',
              isReversal: true,
            },
          ],
          quarterly: [
            { q: 'Q1', asOfDate: '2024-03-31', mv: 120 },
          ],
        },
      };

      // As of 2024-02-15 (before reversal date 2024-03-01): expense is active
      const beforeReversal = computeInv(holding, '2024-02-15');
      expect(beforeReversal!.otherVal).toBe(-5);

      // As of 2024-03-15 (after reversal date 2024-03-01): expense is reversed and filtered out
      const afterReversal = computeInv(holding, '2024-03-15');
      expect(afterReversal!.otherVal).toBe(0);

      // Present-day (no cutoff): expense is reversed and filtered out
      const presentDay = computeInv(holding);
      expect(presentDay!.otherVal).toBe(0);
    });

    it('expense appears exactly once in net performance (not double-counted via otherVal and cash flow)', () => {
      const holding: Holding = {
        id: 'h-single-count',
        n: 'Single Count Inc',
        tp: 'Direct Investments',
        dt: '2024-01-01',
        cost: 100,
        fmv: 0,
        real: 120,
        moic: 1.15,
        st: 'Exited',
        inv: {
          txns: [
            { date: '2024-01-01', type: 'Buy', value: 100, shares: 1000 },
            { date: '2024-02-01', type: 'Other', entryType: 'expense', value: 5, rawCashDelta: '-5000000' },
            { date: '2024-03-01', type: 'Sell', value: 120, shares: 1000 },
          ],
          quarterly: [],
        },
      };

      const metrics = computeInv(holding);
      // In total gross gain: reduced exactly by 5 (from 20 to 15)
      expect(metrics!.totalGrossGain).toBe(15);
      expect(metrics!.otherVal).toBe(-5);

      // In XIRR: flows are [-100, -5, +120]. The -5 occurs exactly once.
      // If otherVal were double-counted in cash flows, total net cash would be 120 - 100 - 5 - 5 = 10.
      expect(metrics!.grossIRR.status).toBe('calculated');
      expect(metrics!.grossIRR.value).toBeGreaterThan(0);
    });

    it('direct and FoF paths agree on the direction of the same economic event', () => {
      const expenseEventTxn = {
        date: '2024-02-01',
        type: 'Other' as const,
        entryType: 'expense',
        value: 5,
        rawCashDelta: '-5000000',
      };

      const incomeEventTxn = {
        date: '2024-02-01',
        type: 'Other' as const,
        entryType: 'income',
        value: 10,
        rawCashDelta: '10000000',
      };

      // Both direct and FoF use signedOtherCashDelta
      expect(signedOtherCashDelta(expenseEventTxn)).toBe(-5);
      expect(signedOtherCashDelta(incomeEventTxn)).toBe(10);

      // Direct holding with expense
      const directWithExpense: Holding = {
        id: 'h-dir-exp',
        n: 'Direct',
        tp: 'Direct Investments',
        dt: '2024-01-01',
        cost: 100,
        fmv: 0,
        real: 120,
        moic: 1.15,
        st: 'Exited',
        inv: {
          txns: [
            { date: '2024-01-01', type: 'Buy', value: 100, shares: 1000 },
            expenseEventTxn,
            { date: '2024-03-01', type: 'Sell', value: 120, shares: 1000 },
          ],
          quarterly: [],
        },
      };

      // FoF holding with expense
      const fofWithExpense: Holding = {
        id: 'h-fof-exp',
        n: 'FoF',
        tp: 'Fund of funds',
        dt: '2024-01-01',
        cost: 100,
        fmv: 0,
        real: 120,
        moic: 1.15,
        st: 'Exited',
        inv: {
          txns: [
            { date: '2024-01-01', type: 'Buy', value: 100 },
            expenseEventTxn,
            { date: '2024-03-01', type: 'Sell', value: 120 },
          ],
          quarterly: [],
        },
      };

      const directRes = computeInv(directWithExpense);
      const fofRes = computeFoF(fofWithExpense);

      // Direct otherVal is -5, FoF totalOther is -5
      expect(directRes!.otherVal).toBe(-5);
      expect(fofRes!.totalOther).toBe(-5);

      // Direct XIRR and FoF XIRR see identical cash flows (-100, -5, +120) and equal IRR
      expect(directRes!.grossIRR.value).toBeCloseTo(fofRes!.xirr!.value!, 4);
    });

    it('scale discipline: rawCashDelta in units is used for sign only and does not corrupt millions-scaled value', () => {
      const txnWithUnitsDelta = {
        date: '2024-02-01',
        type: 'Other' as const,
        entryType: 'expense',
        value: 5, // 5 million
        rawCashDelta: '-5000000.00', // -5,000,000 units (dollars)
      };

      // If rawCashDelta were mistakenly summed into display millions without scale conversion,
      // it would be -5,000,000 instead of -5!
      const delta = signedOtherCashDelta(txnWithUnitsDelta);
      expect(delta).toBe(-5);
      expect(delta).not.toBe(-5000000);
      expect(delta).not.toBe(-5000005);
    });

    it('isEstimatedTxn honors only explicit isEstimated flag and returns false for undefined notes/labels', () => {
      expect(isEstimatedTxn({ isEstimated: true } as any)).toBe(true);
      expect(isEstimatedTxn({ isEstimated: false } as any)).toBe(false);
      expect(isEstimatedTxn({ notes: 'Estimated CIT' } as any)).toBe(false);
      expect(isEstimatedTxn({ label: 'accrual estimate' } as any)).toBe(false);
      expect(isEstimatedTxn({} as any)).toBe(false);
    });
  });

  describe('Investor group lookup (Asset tab)', () => {
    const investors: Investor[] = [
      makeInvestor('inv-1', [], 'Meranti 1', 'PT Sinar Mas Multiartha Tbk', {
        englishName: 'Sinarmas Multiartha',
        legalName: 'PT Sinar Mas Multiartha Tbk Legal',
      }),
      makeInvestor('inv-2', [], 'Startech Growth Fund 1', 'Startech Sub 1'),
      makeInvestor('inv-3', [], null, 'Independent Entity'),
    ];

    it('The group-name lookup resolves an entity whose displayed name differs from investor.n only by case/whitespace', () => {
      const lookup = buildInvestorGroupLookup(investors);

      // Exact match
      expect(resolveInvestorGroupName(lookup, 'PT Sinar Mas Multiartha Tbk')).toBe('Meranti 1');

      // Case difference
      expect(resolveInvestorGroupName(lookup, 'pt sinar mas multiartha tbk')).toBe('Meranti 1');

      // Extra leading, trailing, and internal whitespace
      expect(resolveInvestorGroupName(lookup, '  PT   Sinar  Mas   Multiartha   Tbk  ')).toBe('Meranti 1');

      // Uppercase with whitespace variation
      expect(resolveInvestorGroupName(lookup, ' PT SINAR MAS MULTIARTHA TBK ')).toBe('Meranti 1');

      // Matches englishName with case/whitespace differences
      expect(resolveInvestorGroupName(lookup, '  sinarmas   multiartha  ')).toBe('Meranti 1');

      // Matches parent group name itself
      expect(resolveInvestorGroupName(lookup, 'Startech Growth Fund 1')).toBe('Startech Growth Fund 1');
      expect(resolveInvestorGroupName(lookup, '  startech   growth   fund   1  ')).toBe('Startech Growth Fund 1');
    });

    it('An entity with groupName === null (and one named "Unspecified") still produces a row rather than being dropped', () => {
      const lookup = buildInvestorGroupLookup(investors);

      // Group lookup returns null for entity with groupName === null
      expect(resolveInvestorGroupName(lookup, 'Independent Entity')).toBeNull();

      // Group lookup returns null for 'Unspecified'
      expect(resolveInvestorGroupName(lookup, 'Unspecified')).toBeNull();

      // Test group building and row generation with mock funds and holdings
      const dummyFund = makeFund('fund-1', [
        makeHolding({
          id: 'h-1',
          cost: 10,
          fmv: 15,
          real: 0,
        }),
        makeHolding({
          id: 'h-2',
          cost: 5,
          fmv: 8,
          real: 0,
        }),
        makeHolding({
          id: 'h-3',
          cost: 3,
          fmv: 4,
          real: 0,
        }),
      ]);
      dummyFund.n = 'Main Fund';
      dummyFund.h[0].n = 'Asset 1';
      dummyFund.h[0].d = { entity: 'PT Sinar Mas Multiartha Tbk' };
      dummyFund.h[1].n = 'Asset 2';
      dummyFund.h[1].d = { entity: 'Independent Entity' };
      dummyFund.h[2].n = 'Asset 3';
      dummyFund.h[2].d = {};

      // Slice holdings by investor entity
      const entityIdSet = new Set(investors.map((inv) => inv.id));
      const sliceMap = sliceHoldingsByTxn(
        [dummyFund],
        (t, h, f) => {
          if (entityIdSet.has(f.id)) {
            return f.n;
          }
          return getAssetEntity(h) || 'Unspecified';
        },
        (h, f) => {
          if (entityIdSet.has(f.id)) {
            return [f.n];
          }
          return [getAssetEntity(h) || 'Unspecified'];
        },
        investors,
      );

      const rows = [...sliceMap.entries()].map(([name, items]) => ({
        name,
        items,
        investorGroupName: resolveInvestorGroupName(lookup, name),
      }));

      // Verify all 3 groups/entities exist: grouped entity, entity with groupName === null, and Unspecified
      const entityNames = rows.map((r) => r.name);
      expect(entityNames).toContain('PT Sinar Mas Multiartha Tbk');
      expect(entityNames).toContain('Independent Entity');
      expect(entityNames).toContain('Unspecified');

      const groupedRow = rows.find((r) => r.name === 'PT Sinar Mas Multiartha Tbk')!;
      expect(groupedRow.investorGroupName).toBe('Meranti 1');

      const nullGroupRow = rows.find((r) => r.name === 'Independent Entity')!;
      expect(nullGroupRow.investorGroupName).toBeNull();
      expect(nullGroupRow.items.length).toBeGreaterThan(0);

      const unspecifiedRow = rows.find((r) => r.name === 'Unspecified')!;
      expect(unspecifiedRow.investorGroupName).toBeNull();
      expect(unspecifiedRow.items.length).toBeGreaterThan(0);

      // Verify sorting places grouped rows before ungrouped rows
      rows.sort((x, y) => {
        if (x.investorGroupName && !y.investorGroupName) return -1;
        if (!x.investorGroupName && y.investorGroupName) return 1;
        return 0;
      });

      expect(rows[0].investorGroupName).toBe('Meranti 1');
      expect(rows[1].investorGroupName).toBeNull();
      expect(rows[2].investorGroupName).toBeNull();
    });
  });
});

