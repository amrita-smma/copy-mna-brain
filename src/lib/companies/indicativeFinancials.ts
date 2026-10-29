/**
 * Year window and column labels for the company card's Indicative Financials
 * table — shared by `CompanyOverviewSlide` and the PPTX export so both show
 * the same columns.
 */

/** How many completed fiscal years before the current one the table shows. */
export const INDICATIVE_HISTORY_YEARS = 5;

export interface IndicativeFinancialYear {
  year: number;
  revenue: number | null;
  ebitda: number | null;
}

/**
 * Keep the years from `currentYear - 5` onward that carry a revenue or EBITDA
 * figure, oldest first. Current and future years are kept whatever they are,
 * since they are the projection columns.
 */
export function selectIndicativeFinancialYears(
  rows: IndicativeFinancialYear[],
  currentYear: number = new Date().getFullYear(),
): IndicativeFinancialYear[] {
  const firstYear = currentYear - INDICATIVE_HISTORY_YEARS;
  return rows
    .filter((r) => r.year >= firstYear && (r.revenue != null || r.ebitda != null))
    .sort((a, b) => a.year - b.year);
}

/**
 * Column label for a fiscal year: actuals are bare (`2025`), the current year
 * is a projection (`2026P`) and later years are estimates (`2027E`).
 */
export function fiscalYearLabel(
  year: number,
  currentYear: number = new Date().getFullYear(),
): string {
  if (year < currentYear) return String(year);
  return `${year}${year === currentYear ? 'P' : 'E'}`;
}
