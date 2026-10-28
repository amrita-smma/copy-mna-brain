import { describe, expect, it } from 'vitest';
import type { Tables } from '@/lib/repositories';
import { latestFinancial } from './latestFinancial';

const row = (fiscal_year: number, revenue_usd_mn: number | null) =>
  ({ fiscal_year, revenue_usd_mn, ebitda_usd_mn: null }) as unknown as Tables<'company_financials'>;

const NOW = new Date('2026-06-01T00:00:00Z');

describe('latestFinancial', () => {
  it('returns nulls when there are no financial rows', () => {
    expect(latestFinancial(undefined, 'revenue_usd_mn', NOW)).toEqual({ value: null, year: null });
    expect(latestFinancial([], 'revenue_usd_mn', NOW)).toEqual({ value: null, year: null });
  });

  it('picks the latest year up to the current one, skipping forward years and empty values', () => {
    const rows = [row(2023, 10), row(2025, 30), row(2026, null), row(2027, 99)];
    expect(latestFinancial(rows, 'revenue_usd_mn', NOW)).toEqual({ value: 30, year: 2025 });
  });
});
