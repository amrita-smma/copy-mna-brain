// ============================================
// User Types
// ============================================
export interface User {
  id: string;
  name: string;
  password: string;
  email: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================
// Company Types
// ============================================
export interface Company {
  id: string;

  // Pipeline Stage
  pipeline_stage: DealStage;

  // Details Section
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

  // Status / source (nullable enum)
  source: DealOrigin | null;
  status: CompanyStatus | null;

  // AI Market Screening Remarks (cross-matched with thesis)
  remarks: string | null;

  // Market Screening Fields
  thesis_content: string | null;

  // Metadata
  created_at: string;
  updated_at: string;

  // Relations
  criterias?: CompanyCriteria[];
  financials?: CompanyFinancial[];
  fx_adjustments?: CompanyFxAdjustment[];
  screening_derived?: CompanyScreeningDerived | null;
}

// ============================================
// Company Financial (per-year)
// ============================================
export interface CompanyFinancial {
  id: string;
  company_id: string;
  fiscal_year: number;
  revenue_usd_mn: number | null;
  ebitda_usd_mn: number | null;
  ev_usd_mn: number | null;
  ebitda_margin: number | null;
  ev_ebitda: number | null;
  revenue_cagr_vs_prior: number | null;
  created_at: string;
  updated_at: string;
}

// ============================================
// Company FX Adjustment (per-year)
// ============================================
export interface CompanyFxAdjustment {
  company_id: string;
  fiscal_year: number;
  currency: string;
  revenue_local: number | null;
  assumed_forex: number | null;
  forex_change_vs_prior: number | null;
  revenue_cagr_domestic: number | null;
  created_at: string;
  updated_at: string;
}

// ============================================
// Company Screening Derived (1:1 with companies)
// ============================================
export interface CompanyScreeningDerived {
  company_id: string;

  // L0
  segment_revenue: number | null;
  segment_ebitda: number | null;
  segment_revenue_total_ratio: number | null;
  l0_ebitda_2024_usd_mn: number | null;
  l0_ev_2024_usd_mn: number | null;
  l0_revenue_2024_usd_mn: number | null;
  l0_ev_ebitda_2024: number | null;
  segment_specific_revenue_pct: number | null;
  combined_segment_revenue: string | null;
  pct_from_domestic: number | null;
  l0_ev_usd_mn: number | null;
  revenue_from_priority_geo: boolean | null;

  // L1
  l1_revenue_cagr_l3y: number | null;
  l1_revenue_drop_count: number | null;
  l1_ebitda_below_threshold_count: number | null;
  l1_revenue_cagr_n3y: number | null;
  l1_vision_fit: boolean | null;
  l1_priority_geo: boolean | null;
  l1_ev_below_threshold: boolean | null;
  l1_revenue_no_consecutive_drop: boolean | null;
  l1_rationale: string | null;
  l1_screening_result: L1Result | null;

  // FX summary
  fx_currency: string | null;
  fx_revenue_drop_count: number | null;
  fx_revenue_no_consecutive_drop: boolean | null;
  fx_ebitda_above_10_l3y: boolean | null;
  fx_rationale: string | null;

  computed_at: string | null;
  updated_at: string;
}

// ============================================
// Company Log Types
// ============================================
export interface CompanyLog {
  id: string;
  company_id: string | null;
  action: string;
  details: Record<string, unknown> | null;
  user_id: string | null;
  created_at: string;
  // Relations
  company?: Company;
  user?: User;
}

// ============================================
// Criteria Types
// ============================================
export interface Criteria {
  id: string;
  name: string;
  prompt: string;
  created_at: string;
  updated_at: string;
}

// ============================================
// Company Criteria Types (Many-to-Many Junction)
// ============================================
export interface CompanyCriteria {
  id: string;
  company_id: string;
  criteria_id: string;
  result: string | null;
  created_at: string;
  updated_at: string;
  // Relations
  company?: Company;
  criteria?: Criteria;
}

// ============================================
// Watchlist Status Enum
// ============================================
export type WatchlistStatus = 'Active' | 'Inactive' | 'Pending' | 'Removed';

// ============================================
// Pipeline stages (companies.pipeline_stage)
// ============================================
/** The fixed stage keys: the pre-pipeline buckets and the six original stages. */
type BuiltinDealStage = 'market_screening' | 'unreviewed' | 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'discovered';
/**
 * A companies.pipeline_stage value: a built-in key, or the key of a stage the
 * workspace added in Pipeline Settings (`stg-<hex>`). See `pipeline_stages`.
 */
export type DealStage = BuiltinDealStage | (string & {});

// ============================================
// Company status / source enums (match DB enums)
// ============================================
export type CompanyStatus = 'active' | 'dropped';
export type DealOrigin = 'inbound' | 'outbound';

// ============================================
// L1 screening result enum (matches DB l1_result enum)
// ============================================
export type L1Result = 'pass' | 'fail' | 'inconclusive';

// ============================================
// L1 Status Enum (capitalized form of L1Result returned by the API DTO)
// ============================================
export type L1Status = 'Pass' | 'Fail' | 'Inconclusive';

// ============================================
// Company Insert/Update Types
// ============================================
export interface CompanyInsert {
  // Pipeline Stage
  pipeline_stage?: DealStage;

  // Details Section
  entry_id?: number | null;
  watchlist_id?: number | null;
  segment?: string | null;
  target?: string | null;
  segment_related_offerings?: string | null;
  company_focus?: string | null;
  website?: string | null;
  watchlist_status?: string | null;
  comments?: string | null;
  ownership?: string | null;
  geography?: string | null;

  // Status / source
  source?: DealOrigin | null;
  status?: CompanyStatus | null;

  // AI Market Screening Remarks (cross-matched with thesis)
  remarks?: string | null;

  // Market Screening Fields
  thesis_content?: string | null;
}

export interface CriteriaInsert {
  name: string;
  prompt: string;
}

export interface CompanyCriteriaInsert {
  company_id: string;
  criteria_id: string;
  result?: string | null;
}
