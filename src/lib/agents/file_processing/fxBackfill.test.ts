import { describe, expect, it } from 'vitest';
import {
  applyFxBackfill,
  coerceLocalUnit,
  normalizeFxRow,
  toMillions,
  type FinancialRow,
  type FxRow,
  type RawFxRow,
} from './fxBackfill';

const blankFinancial = (overrides: Partial<FinancialRow> & { fiscal_year: number }): FinancialRow => ({
  revenue_usd_mn: null,
  ebitda_usd_mn: null,
  ev_usd_mn: null,
  ebitda_margin: null,
  ev_ebitda: null,
  revenue_cagr_vs_prior: null,
  ...overrides,
});

const blankFx = (overrides: Partial<FxRow> & { fiscal_year: number; currency: string }): FxRow => ({
  revenue_local: null,
  ebitda_local: null,
  assumed_forex: null,
  forex_change_vs_prior: null,
  revenue_cagr_domestic: null,
  ...overrides,
});

describe('coerceLocalUnit', () => {
  it('accepts canonical short forms', () => {
    expect(coerceLocalUnit('mn')).toBe('mn');
    expect(coerceLocalUnit('bn')).toBe('bn');
    expect(coerceLocalUnit('thousands')).toBe('thousands');
  });

  it('accepts common aliases case-insensitively', () => {
    expect(coerceLocalUnit('Million')).toBe('mn');
    expect(coerceLocalUnit('BILLIONS')).toBe('bn');
    expect(coerceLocalUnit('k')).toBe('thousands');
  });

  it('defaults to mn for missing or unknown values', () => {
    expect(coerceLocalUnit(undefined)).toBe('mn');
    expect(coerceLocalUnit(null)).toBe('mn');
    expect(coerceLocalUnit('')).toBe('mn');
    expect(coerceLocalUnit('lakhs')).toBe('mn');
  });
});

describe('toMillions', () => {
  it('passes mn through unchanged', () => {
    expect(toMillions(36200, 'mn')).toBe(36200);
  });

  it('scales bn up by 1000', () => {
    expect(toMillions(36.2, 'bn')).toBeCloseTo(36200, 6);
  });

  it('scales thousands down by 1000', () => {
    expect(toMillions(36200000, 'thousands')).toBeCloseTo(36200, 6);
  });

  it('preserves null', () => {
    expect(toMillions(null, 'bn')).toBeNull();
  });
});

describe('normalizeFxRow', () => {
  it('converts revenue_local from billions to millions', () => {
    const raw: RawFxRow = {
      fiscal_year: 2023,
      currency: 'KRW',
      revenue_local: 36.2,
      revenue_local_unit: 'bn',
      assumed_forex: 1305,
    };

    const row = normalizeFxRow(raw);

    expect(row.revenue_local).toBeCloseTo(36200, 6);
    expect(row.assumed_forex).toBe(1305);
    expect(row.ebitda_local).toBeNull();
  });

  it('converts revenue and ebitda independently', () => {
    const raw: RawFxRow = {
      fiscal_year: 2024,
      currency: 'IDR',
      revenue_local: 5,
      revenue_local_unit: 'bn',
      ebitda_local: 750,
      ebitda_local_unit: 'mn',
      assumed_forex: 16000,
    };

    const row = normalizeFxRow(raw);

    expect(row.revenue_local).toBeCloseTo(5000, 6);
    expect(row.ebitda_local).toBeCloseTo(750, 6);
  });

  it('treats missing units as mn (canonical)', () => {
    const raw: RawFxRow = {
      fiscal_year: 2023,
      currency: 'USD',
      revenue_local: 100,
      ebitda_local: 20,
      assumed_forex: 1,
    };

    const row = normalizeFxRow(raw);

    expect(row.revenue_local).toBe(100);
    expect(row.ebitda_local).toBe(20);
  });

  it('does not place unit fields on the persisted row', () => {
    const raw: RawFxRow = {
      fiscal_year: 2023,
      currency: 'KRW',
      revenue_local: 36.2,
      revenue_local_unit: 'bn',
      assumed_forex: 1305,
    };

    const row = normalizeFxRow(raw);

    // Type-level guarantee: FxRow has no unit fields. Sanity-check at runtime too.
    expect(Object.keys(row)).not.toContain('revenue_local_unit');
    expect(Object.keys(row)).not.toContain('ebitda_local_unit');
  });
});

describe('applyFxBackfill', () => {
  it('derives revenue_usd_mn from revenue_local / assumed_forex when the USD field is null', () => {
    const financials: FinancialRow[] = [blankFinancial({ fiscal_year: 2023 })];
    const fx: FxRow[] = [
      blankFx({ fiscal_year: 2023, currency: 'KRW', revenue_local: 36200, assumed_forex: 1370 }),
    ];

    applyFxBackfill(financials, fx);

    expect(financials[0].revenue_usd_mn).toBeCloseTo(36200 / 1370, 6);
  });

  it('derives ebitda_usd_mn from ebitda_local / assumed_forex when the USD field is null', () => {
    const financials: FinancialRow[] = [blankFinancial({ fiscal_year: 2023 })];
    const fx: FxRow[] = [
      blankFx({ fiscal_year: 2023, currency: 'KRW', ebitda_local: 12000, assumed_forex: 1370 }),
    ];

    applyFxBackfill(financials, fx);

    expect(financials[0].ebitda_usd_mn).toBeCloseTo(12000 / 1370, 6);
  });

  it('backfills both revenue and ebitda independently in the same pass', () => {
    const financials: FinancialRow[] = [blankFinancial({ fiscal_year: 2023 })];
    const fx: FxRow[] = [
      blankFx({
        fiscal_year: 2023,
        currency: 'KRW',
        revenue_local: 36200,
        ebitda_local: 12000,
        assumed_forex: 1370,
      }),
    ];

    applyFxBackfill(financials, fx);

    expect(financials[0].revenue_usd_mn).toBeCloseTo(36200 / 1370, 6);
    expect(financials[0].ebitda_usd_mn).toBeCloseTo(12000 / 1370, 6);
  });

  it('does not overwrite an existing revenue_usd_mn or ebitda_usd_mn', () => {
    const financials: FinancialRow[] = [
      blankFinancial({ fiscal_year: 2024, revenue_usd_mn: 42, ebitda_usd_mn: 7 }),
    ];
    const fx: FxRow[] = [
      blankFx({
        fiscal_year: 2024,
        currency: 'IDR',
        revenue_local: 600000,
        ebitda_local: 100000,
        assumed_forex: 16000,
      }),
    ];

    applyFxBackfill(financials, fx);

    expect(financials[0].revenue_usd_mn).toBe(42);
    expect(financials[0].ebitda_usd_mn).toBe(7);
  });

  it('matches FX rows to financial rows by fiscal_year only', () => {
    const financials: FinancialRow[] = [
      blankFinancial({ fiscal_year: 2023 }),
      blankFinancial({ fiscal_year: 2024 }),
      blankFinancial({ fiscal_year: 2025 }),
    ];
    const fx: FxRow[] = [
      blankFx({ fiscal_year: 2023, currency: 'KRW', revenue_local: 36200, assumed_forex: 1300 }),
      // 2024 intentionally absent from FX
      blankFx({ fiscal_year: 2025, currency: 'KRW', revenue_local: 56600, assumed_forex: 1380 }),
    ];

    applyFxBackfill(financials, fx);

    expect(financials[0].revenue_usd_mn).toBeCloseTo(36200 / 1300, 6);
    expect(financials[1].revenue_usd_mn).toBeNull();
    expect(financials[2].revenue_usd_mn).toBeCloseTo(56600 / 1380, 6);
  });

  it('leaves the row alone when the FX row has revenue_local null', () => {
    const financials: FinancialRow[] = [blankFinancial({ fiscal_year: 2023 })];
    const fx: FxRow[] = [
      blankFx({ fiscal_year: 2023, currency: 'KRW', assumed_forex: 1370 }),
    ];

    applyFxBackfill(financials, fx);

    expect(financials[0].revenue_usd_mn).toBeNull();
    expect(financials[0].ebitda_usd_mn).toBeNull();
  });

  it('leaves the row alone when assumed_forex is null', () => {
    const financials: FinancialRow[] = [blankFinancial({ fiscal_year: 2023 })];
    const fx: FxRow[] = [
      blankFx({ fiscal_year: 2023, currency: 'KRW', revenue_local: 36200, ebitda_local: 12000 }),
    ];

    applyFxBackfill(financials, fx);

    expect(financials[0].revenue_usd_mn).toBeNull();
    expect(financials[0].ebitda_usd_mn).toBeNull();
  });

  it('does not divide by zero', () => {
    const financials: FinancialRow[] = [blankFinancial({ fiscal_year: 2023 })];
    const fx: FxRow[] = [
      blankFx({
        fiscal_year: 2023,
        currency: 'KRW',
        revenue_local: 36200,
        ebitda_local: 12000,
        assumed_forex: 0,
      }),
    ];

    applyFxBackfill(financials, fx);

    expect(financials[0].revenue_usd_mn).toBeNull();
    expect(financials[0].ebitda_usd_mn).toBeNull();
  });

  it('is a no-op when there are no FX adjustments', () => {
    const financials: FinancialRow[] = [
      blankFinancial({ fiscal_year: 2023 }),
      blankFinancial({ fiscal_year: 2024, revenue_usd_mn: 100 }),
    ];

    applyFxBackfill(financials, []);

    expect(financials[0].revenue_usd_mn).toBeNull();
    expect(financials[1].revenue_usd_mn).toBe(100);
  });

  it('reproduces the Project Zenith case end-to-end with bn → mn normalization', () => {
    // The PDF reports revenue in KRW bn. Model emits revenue_local + unit; the
    // ingest path normalizes to mn before applyFxBackfill runs.
    const rawFx: RawFxRow[] = [
      { fiscal_year: 2023, currency: 'KRW', revenue_local: 36.2, revenue_local_unit: 'bn', assumed_forex: 1305 },
      { fiscal_year: 2024, currency: 'KRW', revenue_local: 40.9, revenue_local_unit: 'bn', assumed_forex: 1360 },
      { fiscal_year: 2025, currency: 'KRW', revenue_local: 56.6, revenue_local_unit: 'bn', assumed_forex: 1370 },
      { fiscal_year: 2026, currency: 'KRW', revenue_local: 75, revenue_local_unit: 'bn', assumed_forex: 1390 },
    ];
    const fx = rawFx.map(normalizeFxRow);

    const financials: FinancialRow[] = [
      blankFinancial({ fiscal_year: 2023 }),
      blankFinancial({ fiscal_year: 2024, revenue_cagr_vs_prior: 0.13 }),
      blankFinancial({ fiscal_year: 2025, revenue_cagr_vs_prior: 0.384 }),
      blankFinancial({ fiscal_year: 2026, revenue_cagr_vs_prior: 0.325 }),
    ];

    applyFxBackfill(financials, fx);

    expect(financials.every((r) => r.revenue_usd_mn !== null)).toBe(true);
    // 36.2 KRW bn = 36200 KRW mn → /1305 ≈ 27.74 USD mn
    expect(financials[0].revenue_usd_mn).toBeCloseTo(27.74, 1);
  });
});
