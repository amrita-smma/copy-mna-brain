/**
 * Backward-compatible handler DTOs for the `companies` resource.
 *
 * DB was normalized (wide columns split into company_financials /
 * company_fx_adjustments / company_screening_derived), but the FE still
 * expects the old flat shape. These DTOs keep the wire format stable while
 * the storage is normalized. Reads compose from the child tables; writes
 * split a flat payload back across them.
 *
 * If you're touching this file: prefer adding fields to the DTO rather than
 * changing wire names — the FE relies on snake_case keys matching the
 * pre-migration `companies` columns.
 */
import type { Tables, TablesInsert } from '@/lib/repositories/types';
import type { DealOrigin, DealStage, CompanyStatus } from '@/lib/types';

const TRACKED_YEARS = [2021, 2022, 2023, 2024] as const;
type TrackedYear = typeof TRACKED_YEARS[number];

/**
 * Flat, FE-facing shape. Mirrors the pre-migration `companies` row so existing
 * FE interfaces / components keep working without changes.
 *
 * Enum-sourced fields (`l1_screening_result`, l1/fx boolean flags) are mapped
 * back to the historical string representations the FE expects.
 */
export interface CompanyDTO {
  id: string;
  pipeline_stage: DealStage;

  entry_id: number | null;
  watchlist_id: number | null;
  segment: string | null;
  target: string | null;
  segment_related_offerings: string | null;
  company_focus: string | null;
  website: string | null;
  watchlist_status: string | null;
  comments: string | null;
  ownership: string | null;
  geography: string | null;
  source: DealOrigin | null;
  status: CompanyStatus | null;

  remarks: string | null;
  thesis_content: string | null;

  created_at: string | null;
  updated_at: string | null;

  // ---- Raw normalized rows from company_financials, ordered by fiscal_year ASC ----
  // Use this for any surface that needs arbitrary-year data. The wide
  // `revenue_YYYY_usd_mn` keys below are kept for backward-compat but are
  // capped to TRACKED_YEARS.
  financials_raw: Tables<'company_financials'>[];

  // ---- Flattened from company_financials (one column per tracked year) ----
  revenue_2021_usd_mn: number | null;
  revenue_2022_usd_mn: number | null;
  revenue_2023_usd_mn: number | null;
  revenue_2024_usd_mn: number | null;
  ebitda_2021_usd_mn: number | null;
  ebitda_2022_usd_mn: number | null;
  ebitda_2023_usd_mn: number | null;
  ebitda_2024_usd_mn: number | null;
  ev_2024: number | null;
  ev_ebitda_2024: number | null;
  ebitda_margin_2021: number | null;
  ebitda_margin_2022: number | null;
  ebitda_margin_2023: number | null;
  ebitda_margin_2024: number | null;
  revenue_cagr_2021_2022: number | null;
  revenue_cagr_2022_2023: number | null;
  revenue_cagr_2023_2024: number | null;

  // ---- Flattened from company_fx_adjustments ----
  fx_currency: string | null;
  fx_revenue_2021: number | null;
  fx_revenue_2022: number | null;
  fx_revenue_2023: number | null;
  fx_revenue_2024: number | null;
  fx_assumed_forex_2021: number | null;
  fx_assumed_forex_2022: number | null;
  fx_assumed_forex_2023: number | null;
  fx_assumed_forex_2024: number | null;
  fx_forex_change_2021_2022: number | null;
  fx_forex_change_2022_2023: number | null;
  fx_forex_change_2023_2024: number | null;
  fx_revenue_cagr_domestic_2021_2022: number | null;
  fx_revenue_cagr_domestic_2022_2023: number | null;
  fx_revenue_cagr_domestic_2023_2024: number | null;

  // ---- Flattened from company_screening_derived ----
  segment_revenue: number | null;
  segment_ebitda: number | null;
  segment_revenue_total_ratio: number | null;
  segment_specific_revenue_pct: number | null;
  combined_segment_revenue: string | null;
  pct_from_domestic: number | null;
  l0_ebitda_2024_usd_mn: number | null;
  l0_ev_2024_usd_mn: number | null;
  l0_revenue_2024_usd_mn: number | null;
  l0_ev_ebitda_2024: number | null;
  l0_ev_usd_mn: number | null;
  l1_revenue_cagr_l3y: number | null;
  l1_revenue_cagr_n3y: number | null;
  l1_revenue_drop_count: number | null;
  l1_ebitda_below_threshold_count: number | null;
  l1_rationale: string | null;
  // Boolean-backed flags surfaced as the historical "Yes"/"No"/null strings
  // to keep the FE comparisons (e.g. `=== 'Yes'`) working.
  revenue_from_priority_geo_flag: string | null;
  l1_vision_fit: string | null;
  l1_priority_geo_flag: string | null;
  l1_ev_below_threshold: string | null;
  l1_revenue_no_consecutive_drop_usd: string | null;
  fx_revenue_drop_count: number | null;
  fx_revenue_no_consecutive_drop_local: string | null;
  fx_ebitda_above_10_l3y: string | null;
  fx_rationale: string | null;
  // l1_result enum → capitalized string the FE renders (`Pass`/`Fail`/`Inconclusive`)
  l1_screening_result: string | null;

  // Users currently assigned (PIC) to this company. Sourced from
  // `company_assignees` join table.
  assignees: Array<Pick<Tables<'users'>, 'id' | 'name' | 'email' | 'role'>>;
}

function boolToYesNo(b: boolean | null | undefined): string | null {
  if (b === true) return 'Yes';
  if (b === false) return 'No';
  return null;
}

function capitalize(s: string | null): string | null {
  if (!s) return null;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Compose a CompanyDTO from the normalized child-table rows. Missing child
 * rows are fine — the corresponding DTO fields come out null.
 */
export function toCompanyDTO(
  company: Tables<'companies'>,
  financials: Tables<'company_financials'>[],
  fx: Tables<'company_fx_adjustments'>[],
  screening: Tables<'company_screening_derived'> | null,
  assignees: Array<Pick<Tables<'users'>, 'id' | 'name' | 'email' | 'role'>> = [],
): CompanyDTO {
  const finByYear = new Map<number, Tables<'company_financials'>>();
  for (const f of financials) finByYear.set(f.fiscal_year, f);
  const fxByYear = new Map<number, Tables<'company_fx_adjustments'>>();
  for (const f of fx) fxByYear.set(f.fiscal_year, f);
  const get = <K extends keyof Tables<'company_financials'>>(year: TrackedYear, key: K) =>
    (finByYear.get(year)?.[key] as number | null) ?? null;
  const fxGet = <K extends keyof Tables<'company_fx_adjustments'>>(year: TrackedYear, key: K) =>
    (fxByYear.get(year)?.[key] as number | null) ?? null;

  return {
    assignees,
    financials_raw: financials,
    id: company.id,
    pipeline_stage: company.pipeline_stage,
    entry_id: company.entry_id,
    watchlist_id: company.watchlist_id,
    segment: company.segment,
    target: company.target,
    segment_related_offerings: company.segment_related_offerings,
    company_focus: company.company_focus,
    website: company.website,
    watchlist_status: company.watchlist_status,
    comments: company.comments,
    ownership: company.ownership,
    geography: company.geography,
    source: company.source,
    status: company.status,
    remarks: company.remarks,
    thesis_content: company.thesis_content,
    created_at: company.created_at,
    updated_at: company.updated_at,

    revenue_2021_usd_mn: get(2021, 'revenue_usd_mn'),
    revenue_2022_usd_mn: get(2022, 'revenue_usd_mn'),
    revenue_2023_usd_mn: get(2023, 'revenue_usd_mn'),
    revenue_2024_usd_mn: get(2024, 'revenue_usd_mn'),
    ebitda_2021_usd_mn: get(2021, 'ebitda_usd_mn'),
    ebitda_2022_usd_mn: get(2022, 'ebitda_usd_mn'),
    ebitda_2023_usd_mn: get(2023, 'ebitda_usd_mn'),
    ebitda_2024_usd_mn: get(2024, 'ebitda_usd_mn'),
    ev_2024: get(2024, 'ev_usd_mn'),
    ev_ebitda_2024: get(2024, 'ev_ebitda'),
    ebitda_margin_2021: get(2021, 'ebitda_margin'),
    ebitda_margin_2022: get(2022, 'ebitda_margin'),
    ebitda_margin_2023: get(2023, 'ebitda_margin'),
    ebitda_margin_2024: get(2024, 'ebitda_margin'),
    revenue_cagr_2021_2022: get(2022, 'revenue_cagr_vs_prior'),
    revenue_cagr_2022_2023: get(2023, 'revenue_cagr_vs_prior'),
    revenue_cagr_2023_2024: get(2024, 'revenue_cagr_vs_prior'),

    fx_currency: fxByYear.get(2024)?.currency ?? fxByYear.get(2023)?.currency ?? fxByYear.get(2022)?.currency ?? fxByYear.get(2021)?.currency ?? null,
    fx_revenue_2021: fxGet(2021, 'revenue_local'),
    fx_revenue_2022: fxGet(2022, 'revenue_local'),
    fx_revenue_2023: fxGet(2023, 'revenue_local'),
    fx_revenue_2024: fxGet(2024, 'revenue_local'),
    fx_assumed_forex_2021: fxGet(2021, 'assumed_forex'),
    fx_assumed_forex_2022: fxGet(2022, 'assumed_forex'),
    fx_assumed_forex_2023: fxGet(2023, 'assumed_forex'),
    fx_assumed_forex_2024: fxGet(2024, 'assumed_forex'),
    fx_forex_change_2021_2022: fxGet(2022, 'forex_change_vs_prior'),
    fx_forex_change_2022_2023: fxGet(2023, 'forex_change_vs_prior'),
    fx_forex_change_2023_2024: fxGet(2024, 'forex_change_vs_prior'),
    fx_revenue_cagr_domestic_2021_2022: fxGet(2022, 'revenue_cagr_domestic'),
    fx_revenue_cagr_domestic_2022_2023: fxGet(2023, 'revenue_cagr_domestic'),
    fx_revenue_cagr_domestic_2023_2024: fxGet(2024, 'revenue_cagr_domestic'),

    segment_revenue: screening?.segment_revenue ?? null,
    segment_ebitda: screening?.segment_ebitda ?? null,
    segment_revenue_total_ratio: screening?.segment_revenue_total_ratio ?? null,
    segment_specific_revenue_pct: screening?.segment_specific_revenue_pct ?? null,
    combined_segment_revenue: screening?.combined_segment_revenue ?? null,
    pct_from_domestic: screening?.pct_from_domestic ?? null,
    l0_ebitda_2024_usd_mn: screening?.l0_ebitda_2024_usd_mn ?? null,
    l0_ev_2024_usd_mn: screening?.l0_ev_2024_usd_mn ?? null,
    l0_revenue_2024_usd_mn: screening?.l0_revenue_2024_usd_mn ?? null,
    l0_ev_ebitda_2024: screening?.l0_ev_ebitda_2024 ?? null,
    l0_ev_usd_mn: screening?.l0_ev_usd_mn ?? null,
    l1_revenue_cagr_l3y: screening?.l1_revenue_cagr_l3y ?? null,
    l1_revenue_cagr_n3y: screening?.l1_revenue_cagr_n3y ?? null,
    l1_revenue_drop_count: screening?.l1_revenue_drop_count ?? null,
    l1_ebitda_below_threshold_count: screening?.l1_ebitda_below_threshold_count ?? null,
    l1_rationale: screening?.l1_rationale ?? null,
    revenue_from_priority_geo_flag: boolToYesNo(screening?.revenue_from_priority_geo),
    l1_vision_fit: boolToYesNo(screening?.l1_vision_fit),
    l1_priority_geo_flag: boolToYesNo(screening?.l1_priority_geo),
    l1_ev_below_threshold: boolToYesNo(screening?.l1_ev_below_threshold),
    l1_revenue_no_consecutive_drop_usd: boolToYesNo(screening?.l1_revenue_no_consecutive_drop),
    fx_revenue_drop_count: screening?.fx_revenue_drop_count ?? null,
    fx_revenue_no_consecutive_drop_local: boolToYesNo(screening?.fx_revenue_no_consecutive_drop),
    fx_ebitda_above_10_l3y: boolToYesNo(screening?.fx_ebitda_above_10_l3y),
    fx_rationale: screening?.fx_rationale ?? null,
    l1_screening_result: capitalize(screening?.l1_screening_result ?? null),
  };
}

// ---------------------------------------------------------------------------
// Write-side split: take a flat DTO-ish payload and produce the
// per-table write fragments.
// ---------------------------------------------------------------------------

/** Subset of `CompanyDTO` the FE may submit on create/patch. All optional. */
export type CompanyDTOInput = Partial<CompanyDTO>;

type CompanyWrite = Partial<TablesInsert<'companies'>>;
type FinancialWrite = Omit<TablesInsert<'company_financials'>, 'company_id' | 'id'>;
type FxWrite = Omit<TablesInsert<'company_fx_adjustments'>, 'company_id'>;
type ScreeningWrite = Partial<Omit<TablesInsert<'company_screening_derived'>, 'company_id'>>;

function yesNoToBool(s: string | null | undefined): boolean | null {
  if (s == null) return null;
  const v = s.trim().toLowerCase();
  if (v === '' ) return null;
  if (['yes', 'y', 'true', 't', 'pass'].includes(v)) return true;
  if (['no', 'n', 'false', 'f', 'fail'].includes(v)) return false;
  return null;
}

function lowerL1Result(s: string | null | undefined): 'pass' | 'fail' | 'inconclusive' | null {
  if (s == null) return null;
  const v = s.trim().toLowerCase();
  if (v === 'pass' || v === 'fail' || v === 'inconclusive') return v;
  return null;
}

export interface SplitCompanyWrite {
  company: CompanyWrite;
  financialsByYear: Map<TrackedYear, FinancialWrite>;
  fxByYear: Map<TrackedYear, FxWrite>;
  screening: ScreeningWrite;
  hasScreeningFields: boolean;
  fxCurrency: string | null | undefined;
}

/**
 * Turn an FE-submitted flat payload into the three per-table write fragments.
 * Only fields that are `undefined` in the input are skipped; `null` is
 * preserved so the FE can clear a value.
 */
export function splitCompanyDTO(dto: CompanyDTOInput): SplitCompanyWrite {
  const company: CompanyWrite = {};
  const financialsByYear = new Map<TrackedYear, FinancialWrite>();
  const fxByYear = new Map<TrackedYear, FxWrite>();
  const screening: ScreeningWrite = {};
  let hasScreeningFields = false;

  // ---- company core ----
  const coreKeys = [
    'entry_id', 'watchlist_id', 'segment', 'target', 'segment_related_offerings',
    'company_focus', 'website', 'watchlist_status', 'comments', 'ownership',
    'geography', 'source', 'status', 'pipeline_stage', 'remarks', 'thesis_content',
  ] as const;
  for (const k of coreKeys) {
    if (k in dto) {
      const v = dto[k];
      // Skip explicit undefined; preserve null
      if (v !== undefined) (company as Record<string, unknown>)[k] = v;
    }
  }

  // ---- financials, per year ----
  const ensureFin = (y: TrackedYear): FinancialWrite => {
    let row = financialsByYear.get(y);
    if (!row) {
      row = { fiscal_year: y };
      financialsByYear.set(y, row);
    }
    return row;
  };
  const finMap: Array<[keyof CompanyDTO, TrackedYear, keyof FinancialWrite]> = [
    ['revenue_2021_usd_mn', 2021, 'revenue_usd_mn'],
    ['revenue_2022_usd_mn', 2022, 'revenue_usd_mn'],
    ['revenue_2023_usd_mn', 2023, 'revenue_usd_mn'],
    ['revenue_2024_usd_mn', 2024, 'revenue_usd_mn'],
    ['ebitda_2021_usd_mn', 2021, 'ebitda_usd_mn'],
    ['ebitda_2022_usd_mn', 2022, 'ebitda_usd_mn'],
    ['ebitda_2023_usd_mn', 2023, 'ebitda_usd_mn'],
    ['ebitda_2024_usd_mn', 2024, 'ebitda_usd_mn'],
    ['ev_2024', 2024, 'ev_usd_mn'],
    ['ev_ebitda_2024', 2024, 'ev_ebitda'],
    ['ebitda_margin_2021', 2021, 'ebitda_margin'],
    ['ebitda_margin_2022', 2022, 'ebitda_margin'],
    ['ebitda_margin_2023', 2023, 'ebitda_margin'],
    ['ebitda_margin_2024', 2024, 'ebitda_margin'],
    ['revenue_cagr_2021_2022', 2022, 'revenue_cagr_vs_prior'],
    ['revenue_cagr_2022_2023', 2023, 'revenue_cagr_vs_prior'],
    ['revenue_cagr_2023_2024', 2024, 'revenue_cagr_vs_prior'],
  ];
  for (const [dtoKey, year, finKey] of finMap) {
    if (dtoKey in dto) {
      const v = dto[dtoKey];
      if (v !== undefined) (ensureFin(year) as Record<string, unknown>)[finKey] = v;
    }
  }

  // ---- fx, per year ----
  const ensureFx = (y: TrackedYear): FxWrite => {
    let row = fxByYear.get(y);
    if (!row) {
      row = { fiscal_year: y, currency: '' }; // currency patched below
      fxByYear.set(y, row);
    }
    return row;
  };
  const fxMap: Array<[keyof CompanyDTO, TrackedYear, keyof FxWrite]> = [
    ['fx_revenue_2021', 2021, 'revenue_local'],
    ['fx_revenue_2022', 2022, 'revenue_local'],
    ['fx_revenue_2023', 2023, 'revenue_local'],
    ['fx_revenue_2024', 2024, 'revenue_local'],
    ['fx_assumed_forex_2021', 2021, 'assumed_forex'],
    ['fx_assumed_forex_2022', 2022, 'assumed_forex'],
    ['fx_assumed_forex_2023', 2023, 'assumed_forex'],
    ['fx_assumed_forex_2024', 2024, 'assumed_forex'],
    ['fx_forex_change_2021_2022', 2022, 'forex_change_vs_prior'],
    ['fx_forex_change_2022_2023', 2023, 'forex_change_vs_prior'],
    ['fx_forex_change_2023_2024', 2024, 'forex_change_vs_prior'],
    ['fx_revenue_cagr_domestic_2021_2022', 2022, 'revenue_cagr_domestic'],
    ['fx_revenue_cagr_domestic_2022_2023', 2023, 'revenue_cagr_domestic'],
    ['fx_revenue_cagr_domestic_2023_2024', 2024, 'revenue_cagr_domestic'],
  ];
  for (const [dtoKey, year, fxKey] of fxMap) {
    if (dtoKey in dto) {
      const v = dto[dtoKey];
      if (v !== undefined) (ensureFx(year) as Record<string, unknown>)[fxKey] = v;
    }
  }
  const fxCurrency = dto.fx_currency;
  if (fxCurrency !== undefined && fxCurrency !== null && fxCurrency !== '') {
    // stamp the currency on every fx row we're about to write
    for (const row of fxByYear.values()) row.currency = fxCurrency;
  }

  // ---- screening_derived ----
  const mark = <K extends keyof ScreeningWrite>(key: K, value: ScreeningWrite[K]) => {
    (screening as Record<string, unknown>)[key as string] = value as unknown;
    hasScreeningFields = true;
  };
  if ('segment_revenue' in dto && dto.segment_revenue !== undefined) mark('segment_revenue', dto.segment_revenue);
  if ('segment_ebitda' in dto && dto.segment_ebitda !== undefined) mark('segment_ebitda', dto.segment_ebitda);
  if ('segment_revenue_total_ratio' in dto && dto.segment_revenue_total_ratio !== undefined) mark('segment_revenue_total_ratio', dto.segment_revenue_total_ratio);
  if ('segment_specific_revenue_pct' in dto && dto.segment_specific_revenue_pct !== undefined) mark('segment_specific_revenue_pct', dto.segment_specific_revenue_pct);
  if ('combined_segment_revenue' in dto && dto.combined_segment_revenue !== undefined) mark('combined_segment_revenue', dto.combined_segment_revenue);
  if ('pct_from_domestic' in dto && dto.pct_from_domestic !== undefined) mark('pct_from_domestic', dto.pct_from_domestic);
  if ('l0_ebitda_2024_usd_mn' in dto && dto.l0_ebitda_2024_usd_mn !== undefined) mark('l0_ebitda_2024_usd_mn', dto.l0_ebitda_2024_usd_mn);
  if ('l0_ev_2024_usd_mn' in dto && dto.l0_ev_2024_usd_mn !== undefined) mark('l0_ev_2024_usd_mn', dto.l0_ev_2024_usd_mn);
  if ('l0_revenue_2024_usd_mn' in dto && dto.l0_revenue_2024_usd_mn !== undefined) mark('l0_revenue_2024_usd_mn', dto.l0_revenue_2024_usd_mn);
  if ('l0_ev_ebitda_2024' in dto && dto.l0_ev_ebitda_2024 !== undefined) mark('l0_ev_ebitda_2024', dto.l0_ev_ebitda_2024);
  if ('l0_ev_usd_mn' in dto && dto.l0_ev_usd_mn !== undefined) mark('l0_ev_usd_mn', dto.l0_ev_usd_mn);
  if ('l1_revenue_cagr_l3y' in dto && dto.l1_revenue_cagr_l3y !== undefined) mark('l1_revenue_cagr_l3y', dto.l1_revenue_cagr_l3y);
  if ('l1_revenue_cagr_n3y' in dto && dto.l1_revenue_cagr_n3y !== undefined) mark('l1_revenue_cagr_n3y', dto.l1_revenue_cagr_n3y);
  if ('l1_revenue_drop_count' in dto && dto.l1_revenue_drop_count !== undefined) mark('l1_revenue_drop_count', dto.l1_revenue_drop_count);
  if ('l1_ebitda_below_threshold_count' in dto && dto.l1_ebitda_below_threshold_count !== undefined) mark('l1_ebitda_below_threshold_count', dto.l1_ebitda_below_threshold_count);
  if ('l1_rationale' in dto && dto.l1_rationale !== undefined) mark('l1_rationale', dto.l1_rationale);
  if ('revenue_from_priority_geo_flag' in dto && dto.revenue_from_priority_geo_flag !== undefined) mark('revenue_from_priority_geo', yesNoToBool(dto.revenue_from_priority_geo_flag));
  if ('l1_vision_fit' in dto && dto.l1_vision_fit !== undefined) mark('l1_vision_fit', yesNoToBool(dto.l1_vision_fit));
  if ('l1_priority_geo_flag' in dto && dto.l1_priority_geo_flag !== undefined) mark('l1_priority_geo', yesNoToBool(dto.l1_priority_geo_flag));
  if ('l1_ev_below_threshold' in dto && dto.l1_ev_below_threshold !== undefined) mark('l1_ev_below_threshold', yesNoToBool(dto.l1_ev_below_threshold));
  if ('l1_revenue_no_consecutive_drop_usd' in dto && dto.l1_revenue_no_consecutive_drop_usd !== undefined) mark('l1_revenue_no_consecutive_drop', yesNoToBool(dto.l1_revenue_no_consecutive_drop_usd));
  if ('fx_revenue_drop_count' in dto && dto.fx_revenue_drop_count !== undefined) mark('fx_revenue_drop_count', dto.fx_revenue_drop_count);
  if ('fx_revenue_no_consecutive_drop_local' in dto && dto.fx_revenue_no_consecutive_drop_local !== undefined) mark('fx_revenue_no_consecutive_drop', yesNoToBool(dto.fx_revenue_no_consecutive_drop_local));
  if ('fx_ebitda_above_10_l3y' in dto && dto.fx_ebitda_above_10_l3y !== undefined) mark('fx_ebitda_above_10_l3y', yesNoToBool(dto.fx_ebitda_above_10_l3y));
  if ('fx_rationale' in dto && dto.fx_rationale !== undefined) mark('fx_rationale', dto.fx_rationale);
  if ('l1_screening_result' in dto && dto.l1_screening_result !== undefined) mark('l1_screening_result', lowerL1Result(dto.l1_screening_result));
  // screening also exposes fx_currency as a summary field
  if (fxCurrency !== undefined) mark('fx_currency', fxCurrency);

  return { company, financialsByYear, fxByYear, screening, hasScreeningFields, fxCurrency };
}

export { TRACKED_YEARS };
