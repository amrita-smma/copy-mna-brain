import { describe, it, expect } from 'vitest';
import {
  canSubmitTxnDialog,
  computeFoF,
  getAssetDisplayName,
  getNextSellProceedsDestination,
  holdingsPortfolioTotals,
  mergeHoldingsAcrossFunds,
  proceedsTreatmentLabel,
  proceedsTreatmentOptionsFor,
  scopeHoldingToFund,
  splitHoldingByTxn,
  txnTypeLabel,
} from './calc';
import type { Fund, Holding, Inv } from './types';

function makeHolding(overrides: {
  id?: string;
  cost?: number;
  fmv?: number;
  real?: number;
  txns?: Inv['txns'];
  fundId?: string | null;
} = {}): Holding {
  const txns: Inv['txns'] = overrides.txns ?? [];
  return {
    id: overrides.id,
    n: 'Test Asset',
    tp: 'Equity',
    dt: '2024-01-01',
    cost: overrides.cost ?? 100,
    fmv: overrides.fmv ?? 120,
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
    // One fund_assets row whose ledger names two funds: each fund's copy is
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
});
