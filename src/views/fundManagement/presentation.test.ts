import { describe, it, expect } from 'vitest';
import type { FlPortfolioPosition } from '@/lib/api/fundLedger';
import type { Fund, Holding, Investor } from './types';
import {
  buildCommitmentByTarget,
  buildPresentationReport,
  fmtAmount,
  fmtDpi,
  fmtIrr,
  fmtMoic,
  formatMonthYear,
  formatPeriodEnd,
  quarterEndOnOrBefore,
  UNASSIGNED_GROUP,
} from './presentation';

function makeHolding(overrides: Partial<Holding> & { id: string }): Holding {
  return {
    n: `Asset ${overrides.id}`,
    tp: 'Equity',
    dt: '2020-01-01',
    cost: 2,
    fmv: 3,
    real: 1,
    moic: 2,
    st: 'Active',
    positionId: `pos-${overrides.id}`,
    inv: { txns: [], quarterly: [] },
    ...overrides,
  };
}

function makeFund(id: string, holdings: Holding[]): Fund {
  return {
    id,
    n: `Fund ${id}`,
    v: 2020,
    size: 0,
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

const TYPES = [
  { id: 't-realized', name: 'Realized Funds' },
  { id: 't-vc', name: 'Venture Capital' },
  { id: 't-pe', name: 'Private Equity' },
];

describe('buildPresentationReport', () => {
  it('groups assets by investment type in configured order with Unassigned last and empty types omitted', () => {
    const report = buildPresentationReport({
      funds: [
        makeFund('f1', [
          makeHolding({ id: 'a', investmentTypeId: 't-vc' }),
          makeHolding({ id: 'b', investmentTypeId: null }),
          makeHolding({ id: 'c', investmentTypeId: 't-realized' }),
        ]),
      ],
      investmentTypes: TYPES,
    });

    expect(report.groups.map((g) => g.name)).toEqual([
      'Realized Funds',
      'Venture Capital',
      UNASSIGNED_GROUP,
    ]);
  });

  it('numbers rows continuously across groups, oldest entry first within a group', () => {
    const report = buildPresentationReport({
      funds: [
        makeFund('f1', [
          makeHolding({ id: 'late', investmentTypeId: 't-vc', dt: '2023-05-01' }),
          makeHolding({ id: 'early', investmentTypeId: 't-vc', dt: '2018-08-01' }),
          makeHolding({ id: 'realized', investmentTypeId: 't-realized', dt: '2017-12-01' }),
        ]),
      ],
      investmentTypes: TYPES,
    });

    const rows = report.groups.flatMap((g) => g.rows.map((r) => [r.no, r.name]));
    expect(rows).toEqual([
      [1, 'Asset realized'],
      [2, 'Asset early'],
      [3, 'Asset late'],
    ]);
  });

  it('merges a co-invested asset into one row and drops display-only and cash rows', () => {
    const report = buildPresentationReport({
      funds: [
        makeFund('f1', [
          makeHolding({ id: 'shared', positionId: 'p1', cost: 1, fmv: 2, real: 0 }),
          makeHolding({ id: 'cash', tp: 'Cash' }),
          makeHolding({ id: 'ext', displayOnly: true }),
        ]),
        makeFund('f2', [makeHolding({ id: 'shared', positionId: 'p2', cost: 3, fmv: 4, real: 1 })]),
      ],
      investmentTypes: TYPES,
    });

    const rows = report.groups.flatMap((g) => g.rows);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ invested: 4, unrealizedValue: 6, netDistribution: 1 });
  });

  it('computes MOIC and DPI per row and totals, leaving MOIC blank when a row is unvalued', () => {
    const report = buildPresentationReport({
      funds: [
        makeFund('f1', [
          makeHolding({ id: 'a', investmentTypeId: 't-vc', cost: 5, fmv: 13.8, real: 2.3 }),
          makeHolding({ id: 'b', investmentTypeId: 't-pe', cost: 4, fmv: null, real: 0 }),
        ]),
      ],
      investmentTypes: TYPES,
    });

    const [vc, pe] = report.groups;
    expect(vc.rows[0].moic).toBeCloseTo(3.22, 2);
    expect(vc.rows[0].dpi).toBeCloseTo(0.46, 2);
    expect(vc.total.moic).toBeCloseTo(3.22, 2);
    expect(pe.rows[0].moic).toBeNull();
    expect(pe.total.moic).toBeNull();
    expect(report.grandTotal).toMatchObject({ invested: 9, netDistribution: 2.3 });
    expect(report.grandTotal.moic).toBeNull();
  });

  it('uses the recorded commitment when present and falls back to invested capital', () => {
    const report = buildPresentationReport({
      funds: [
        makeFund('f1', [
          makeHolding({ id: 'fof', cost: 1.7 }),
          makeHolding({ id: 'direct', cost: 2 }),
        ]),
      ],
      investmentTypes: TYPES,
      commitmentByTarget: new Map([['fof', 3.4]]),
    });

    const byName = new Map(report.groups[0].rows.map((r) => [r.name, r.commitment]));
    expect(byName.get('Asset fof')).toBe(3.4);
    expect(byName.get('Asset direct')).toBe(2);
  });

  it("falls back to the fund interest's recorded commitment when the ledger has none", () => {
    const report = buildPresentationReport({
      funds: [
        makeFund('f1', [
          makeHolding({ id: 'fof', cost: 1.7, d: { commitmentAmount: '3400000.00000000' } }),
          makeHolding({ id: 'ledger', cost: 1, d: { commitmentAmount: '9000000' } }),
        ]),
      ],
      investmentTypes: TYPES,
      commitmentByTarget: new Map([['ledger', 2]]),
    });

    const byName = new Map(report.groups[0].rows.map((r) => [r.name, r.commitment]));
    expect(byName.get('Asset fof')).toBe(3.4);
    expect(byName.get('Asset ledger')).toBe(2);
  });

  it('takes the entry date from the first real deployment and derives maturity from fund life', () => {
    const report = buildPresentationReport({
      funds: [
        makeFund('f1', [
          makeHolding({
            id: 'fof',
            tp: 'Fund of funds',
            dt: '2022-01-01',
            d: { fundLifeYears: 10 },
            inv: {
              txns: [
                { date: '2021-08-15', type: 'Buy', value: 1, isGenerated: true },
                { date: '2021-08-20', type: 'Buy', value: 1, isEstimated: true },
                { date: '2021-09-10', type: 'Buy', value: 1 },
                { date: '2023-01-01', type: 'Buy', value: 1 },
              ],
              quarterly: [],
            },
          }),
          makeHolding({ id: 'loan', tp: 'Obligation', d: { maturity: '2028-05-31' } }),
        ]),
      ],
      investmentTypes: TYPES,
    });

    const byName = new Map(report.groups[0].rows.map((r) => [r.name, r]));
    expect(byName.get('Asset fof')).toMatchObject({
      entryDate: '2021-09-10',
      maturityDate: '2031-09-10',
    });
    expect(byName.get('Asset loan')).toMatchObject({
      entryDate: '2020-01-01',
      maturityDate: '2028-05-31',
    });
  });

  it('excludes fund targets when asked to mirror the Fund Vehicle View asset tab', () => {
    const report = buildPresentationReport({
      funds: [
        makeFund('f1', [
          makeHolding({ id: 'asset' }),
          makeHolding({ id: 'target-fund', targetKind: 'fund', tp: 'Fund of funds' }),
        ]),
      ],
      investmentTypes: TYPES,
      excludeFundTargets: true,
    });

    expect(report.groups.flatMap((g) => g.rows.map((r) => r.name))).toEqual(['Asset asset']);
  });

  it('includes investor-held holdings and reports the latest valuation mark', () => {
    const investor: Investor = {
      id: 'inv-1',
      n: 'Entity',
      type: 'Corporate',
      stakes: {},
      holdings: [
        makeHolding({
          id: 'held',
          inv: { txns: [], quarterly: [{ q: "Q1'26", asOfDate: '2026-03-31', mv: 3 }] },
        }),
      ],
    };
    const report = buildPresentationReport({
      funds: [],
      investors: [investor],
      investmentTypes: TYPES,
    });

    expect(report.groups[0].rows.map((r) => r.name)).toEqual(['Asset held']);
    expect(report.latestValuationDate).toBe('2026-03-31');
  });

  it('returns no groups and zero totals for an empty portfolio', () => {
    const report = buildPresentationReport({ funds: [], investmentTypes: TYPES });
    expect(report.groups).toEqual([]);
    expect(report.grandTotal).toMatchObject({ invested: 0, moic: null, dpi: null });
  });
});

describe('buildCommitmentByTarget', () => {
  const pos = (overrides: Partial<FlPortfolioPosition>): FlPortfolioPosition =>
    ({ asset_id: null, fund_id: null, asset: null, ...overrides }) as FlPortfolioPosition;

  it('sums commitment per asset or target fund in millions, skipping cash and zero balances', () => {
    const map = buildCommitmentByTarget([
      pos({ asset_id: 'a', balance: { commitment: '2000000' } as FlPortfolioPosition['balance'] }),
      pos({ asset_id: 'a', balance: { commitment: '1500000' } as FlPortfolioPosition['balance'] }),
      pos({ fund_id: 'f', balance: { committed: '5000000' } as FlPortfolioPosition['balance'] }),
      pos({ asset_id: 'z', balance: { commitment: '0' } as FlPortfolioPosition['balance'] }),
      pos({
        asset_id: 'cash',
        balance: { asset_kind: 'cash', commitment: '9000000' } as FlPortfolioPosition['balance'],
      }),
    ]);

    expect(Object.fromEntries(map)).toEqual({ a: 3.5, f: 5 });
  });
});

describe('quarterEndOnOrBefore', () => {
  it('returns the latest calendar quarter end not after the date', () => {
    expect(quarterEndOnOrBefore('2026-10-19')).toBe('2026-09-30');
    expect(quarterEndOnOrBefore('2026-09-30')).toBe('2026-09-30');
    expect(quarterEndOnOrBefore('2026-12-31')).toBe('2026-12-31');
    expect(quarterEndOnOrBefore('2026-02-10')).toBe('2025-12-31');
  });
});

describe('report formatters', () => {
  it('formats dates the way the valuation report prints them', () => {
    expect(formatMonthYear('2017-12-01')).toBe('Dec 2017');
    expect(formatMonthYear(null)).toBe('-');
    expect(formatPeriodEnd('2026-09-30')).toBe('Sep 30th, 2026');
    expect(formatPeriodEnd('2026-03-31')).toBe('Mar 31st, 2026');
    expect(formatPeriodEnd('2026-06-12')).toBe('Jun 12th, 2026');
  });

  it('formats amounts and ratios with report precision and a dash for missing values', () => {
    expect(fmtAmount(32.44)).toBe('32.4');
    expect(fmtAmount(-0.01)).toBe('0.0');
    expect(fmtAmount(null)).toBe('-');
    expect(fmtMoic(1.2)).toBe('1.20x');
    expect(fmtIrr(0.047)).toBe('4.7%');
    expect(fmtIrr(null)).toBe('-');
    expect(fmtDpi(1.234)).toBe('1.2x');
  });
});
