export type FinancialRow = {
  fiscal_year: number;
  revenue_usd_mn: number | null;
  ebitda_usd_mn: number | null;
  ev_usd_mn: number | null;
  ebitda_margin: number | null;
  ev_ebitda: number | null;
  revenue_cagr_vs_prior: number | null;
};

export type FxRow = {
  fiscal_year: number;
  currency: string;
  revenue_local: number | null;
  ebitda_local: number | null;
  assumed_forex: number | null;
  forex_change_vs_prior: number | null;
  revenue_cagr_domestic: number | null;
};

export type LocalUnit = 'mn' | 'bn' | 'thousands';

const UNIT_MULTIPLIER: Record<LocalUnit, number> = {
  mn: 1,
  bn: 1000,
  thousands: 0.001,
};

/**
 * Coerce a model-stated unit string to a known LocalUnit, defaulting to "mn"
 * when the value is missing or not recognized. Accepts a few common aliases.
 */
export function coerceLocalUnit(raw: unknown): LocalUnit {
  if (typeof raw !== 'string') return 'mn';
  const v = raw.trim().toLowerCase();
  if (v === 'mn' || v === 'million' || v === 'millions' || v === 'm') return 'mn';
  if (v === 'bn' || v === 'billion' || v === 'billions' || v === 'b') return 'bn';
  if (v === 'thousands' || v === 'thousand' || v === 'k') return 'thousands';
  return 'mn';
}

/**
 * Convert a raw value expressed in the given local unit into millions of the
 * same currency. Returns null when the value is null.
 */
export function toMillions(value: number | null, unit: LocalUnit): number | null {
  if (value === null) return null;
  return value * UNIT_MULTIPLIER[unit];
}

/**
 * Shape of a single fx_adjustments row as emitted by the LLM, before unit
 * normalization. The `*_unit` fields are transient — they are consumed at
 * ingest and not persisted.
 */
export type RawFxRow = {
  fiscal_year: number;
  currency: string;
  revenue_local?: number | null;
  revenue_local_unit?: unknown;
  ebitda_local?: number | null;
  ebitda_local_unit?: unknown;
  assumed_forex?: number | null;
  forex_change_vs_prior?: number | null;
  revenue_cagr_domestic?: number | null;
};

/**
 * Normalize a raw FX row from the LLM output into the canonical FxRow shape
 * that we persist (`revenue_local` and `ebitda_local` always in millions of
 * local currency). The `*_unit` fields are read here and dropped.
 */
export function normalizeFxRow(raw: RawFxRow): FxRow {
  const revenueUnit = coerceLocalUnit(raw.revenue_local_unit);
  const ebitdaUnit = coerceLocalUnit(raw.ebitda_local_unit);
  return {
    fiscal_year: raw.fiscal_year,
    currency: raw.currency,
    revenue_local: toMillions(raw.revenue_local ?? null, revenueUnit),
    ebitda_local: toMillions(raw.ebitda_local ?? null, ebitdaUnit),
    assumed_forex: raw.assumed_forex ?? null,
    forex_change_vs_prior: raw.forex_change_vs_prior ?? null,
    revenue_cagr_domestic: raw.revenue_cagr_domestic ?? null,
  };
}

/**
 * Backfill `revenue_usd_mn` and `ebitda_usd_mn` on financial rows from FX
 * adjustments when the extractor only reported local-currency figures.
 *
 * `assumed_forex` is local currency per 1 USD (e.g. KRW 1370/USD).
 * `revenue_local` and `ebitda_local` are in millions of local currency.
 *
 * Mutates `financialRows` in place and also returns it for chaining. USD
 * fields that are already set are left untouched.
 */
export function applyFxBackfill(
  financialRows: FinancialRow[],
  fxRows: FxRow[],
): FinancialRow[] {
  const fxByYear = new Map<number, FxRow>(fxRows.map((f) => [f.fiscal_year, f]));
  for (const row of financialRows) {
    const fx = fxByYear.get(row.fiscal_year);
    if (!fx || fx.assumed_forex === null || fx.assumed_forex === 0) continue;

    if (row.revenue_usd_mn === null && fx.revenue_local !== null) {
      row.revenue_usd_mn = fx.revenue_local / fx.assumed_forex;
    }
    if (row.ebitda_usd_mn === null && fx.ebitda_local !== null) {
      row.ebitda_usd_mn = fx.ebitda_local / fx.assumed_forex;
    }
  }
  return financialRows;
}

export type FxConsistencyWarning = {
  fiscal_year: number;
  field: 'revenue' | 'ebitda';
  reported_usd_mn: number;
  derived_usd_mn: number;
  divergence_ratio: number;
  /** Whichever side was kept. We trust USD because the LLM tends to err on
   * non-decimal local unit conversions (e.g. 億, 万) but extracts USD
   * directly from the document or computes it contextually. */
  resolved_local_mn: number;
};

/**
 * Cross-check `revenue_usd_mn` and `ebitda_usd_mn` against
 * `revenue_local / assumed_forex` (and ebitda equivalent) for each year that
 * has both. When the two disagree by more than 5%, trust the USD value and
 * recompute `*_local` so the FX row stays internally consistent. Returns the
 * list of corrections so the caller can log/surface them.
 *
 * Mutates `fxRows` in place.
 */
export function validateFxConsistency(
  financialRows: FinancialRow[],
  fxRows: FxRow[],
  toleranceRatio: number = 0.05,
): FxConsistencyWarning[] {
  const warnings: FxConsistencyWarning[] = [];
  const finByYear = new Map<number, FinancialRow>(
    financialRows.map((r) => [r.fiscal_year, r]),
  );

  for (const fx of fxRows) {
    if (fx.assumed_forex === null || fx.assumed_forex === 0) continue;
    const fin = finByYear.get(fx.fiscal_year);
    if (!fin) continue;

    if (fin.revenue_usd_mn !== null && fx.revenue_local !== null) {
      const derived = fx.revenue_local / fx.assumed_forex;
      const denom = Math.max(Math.abs(fin.revenue_usd_mn), Math.abs(derived), 1);
      const ratio = Math.abs(derived - fin.revenue_usd_mn) / denom;
      if (ratio > toleranceRatio) {
        const corrected = fin.revenue_usd_mn * fx.assumed_forex;
        warnings.push({
          fiscal_year: fx.fiscal_year,
          field: 'revenue',
          reported_usd_mn: fin.revenue_usd_mn,
          derived_usd_mn: derived,
          divergence_ratio: ratio,
          resolved_local_mn: corrected,
        });
        fx.revenue_local = corrected;
      }
    }

    if (fin.ebitda_usd_mn !== null && fx.ebitda_local !== null) {
      const derived = fx.ebitda_local / fx.assumed_forex;
      const denom = Math.max(Math.abs(fin.ebitda_usd_mn), Math.abs(derived), 1);
      const ratio = Math.abs(derived - fin.ebitda_usd_mn) / denom;
      if (ratio > toleranceRatio) {
        const corrected = fin.ebitda_usd_mn * fx.assumed_forex;
        warnings.push({
          fiscal_year: fx.fiscal_year,
          field: 'ebitda',
          reported_usd_mn: fin.ebitda_usd_mn,
          derived_usd_mn: derived,
          divergence_ratio: ratio,
          resolved_local_mn: corrected,
        });
        fx.ebitda_local = corrected;
      }
    }
  }

  return warnings;
}
