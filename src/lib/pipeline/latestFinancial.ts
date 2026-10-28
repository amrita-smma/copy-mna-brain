import type { Tables } from '@/lib/repositories';

/**
 * Current-year value for `key`, falling back to the nearest previous year when
 * the current year is missing. Forward (future) fiscal years are never shown.
 * Shared by the pipeline table and the pipeline presentation so both show the
 * same figure for a company.
 */
export function latestFinancial(
  rows: Tables<'company_financials'>[] | undefined,
  key: 'revenue_usd_mn' | 'ebitda_usd_mn',
  now: Date = new Date(),
): { value: number | null; year: number | null } {
  if (!rows?.length) return { value: null, year: null };
  const currentYear = now.getFullYear();
  let best: { value: number; year: number } | null = null;
  for (const r of rows) {
    const v = r[key] as number | null;
    if (v == null) continue;
    if (r.fiscal_year > currentYear) continue;
    if (!best || r.fiscal_year > best.year) best = { value: v, year: r.fiscal_year };
  }
  return best ?? { value: null, year: null };
}
