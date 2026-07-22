import { describe, it, expect } from 'vitest';
import { mergeHoldingsAcrossFunds, scopeHoldingToFund, holdingsPortfolioTotals } from './calc';
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
        { date: '2024-06-01', type: 'Distribution', value: 10, fundId: null },
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
        { date: '2024-03-01', type: 'Distribution', value: 20, fundId: 'f1' },
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
