import { describe, expect, it } from 'vitest';
import { fiscalYearLabel, selectIndicativeFinancialYears } from './indicativeFinancials';

const row = (year: number, revenue: number | null = 10, ebitda: number | null = 2) => ({
  year,
  revenue,
  ebitda,
});

describe('selectIndicativeFinancialYears', () => {
  it('keeps the five years before the current year plus current and future years', () => {
    const rows = [2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026, 2027, 2028].map((y) => row(y));
    expect(selectIndicativeFinancialYears(rows, 2026).map((r) => r.year)).toEqual([
      2021, 2022, 2023, 2024, 2025, 2026, 2027, 2028,
    ]);
  });

  it('sorts oldest first', () => {
    const rows = [row(2025), row(2022), row(2026)];
    expect(selectIndicativeFinancialYears(rows, 2026).map((r) => r.year)).toEqual([
      2022, 2025, 2026,
    ]);
  });

  it('drops years with neither revenue nor EBITDA', () => {
    const rows = [row(2023, null, null), row(2024, null, 1), row(2025, 5, null)];
    expect(selectIndicativeFinancialYears(rows, 2026).map((r) => r.year)).toEqual([2024, 2025]);
  });

  it('returns [] when every year is older than the window', () => {
    expect(selectIndicativeFinancialYears([row(2018), row(2020)], 2026)).toEqual([]);
  });
});

describe('fiscalYearLabel', () => {
  it('leaves past years bare', () => {
    expect(fiscalYearLabel(2025, 2026)).toBe('2025');
  });

  it('suffixes the current year with P', () => {
    expect(fiscalYearLabel(2026, 2026)).toBe('2026P');
  });

  it('suffixes future years with E', () => {
    expect(fiscalYearLabel(2027, 2026)).toBe('2027E');
    expect(fiscalYearLabel(2030, 2026)).toBe('2030E');
  });
});
