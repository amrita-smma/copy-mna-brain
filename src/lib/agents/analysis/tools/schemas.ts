/**
 * Shared schema definitions for the analysis agent's tools.
 * Exported so callers (e.g., job handlers) can include them in their prompts.
 */
export const companiesSchema = [
  // Core identifiers
  { name: "id", type: "uuid" },
  { name: "entry_id", type: "integer" },
  { name: "watchlist_id", type: "integer" },
  // Basic info
  { name: "target", type: "text" },
  { name: "segment", type: "text" },
  { name: "segment_related_offerings", type: "text" },
  { name: "company_focus", type: "text" },
  { name: "website", type: "text" },
  { name: "watchlist_status", type: "text" },
  { name: "pipeline_stage", type: "pipeline_stage (enum: market_screening, L0, L1, L2, L3, L4, L5)" },
  { name: "comments", type: "text" },
  { name: "ownership", type: "text" },
  { name: "geography", type: "text" },
  { name: "source", type: "deal_origin (enum: inbound, outbound)" },
  { name: "status", type: "company_status (enum: active, dropped)" },
  { name: "remarks", type: "text" },
  { name: "thesis_content", type: "text" },
  { name: "created_at", type: "timestamptz" },
  { name: "updated_at", type: "timestamptz" },
];

/**
 * Yearly financials live in company_financials, one row per (company_id, fiscal_year).
 * Join via company_financials.company_id = companies.id.
 */
export const companyFinancialsSchema = [
  { name: "company_id", type: "uuid (FK companies.id)" },
  { name: "fiscal_year", type: "integer (1990..2100)" },
  { name: "revenue_usd_mn", type: "numeric" },
  { name: "ebitda_usd_mn", type: "numeric" },
  { name: "ev_usd_mn", type: "numeric" },
  { name: "ebitda_margin", type: "numeric" },
  { name: "ev_ebitda", type: "numeric" },
  { name: "revenue_cagr_vs_prior", type: "numeric (YoY CAGR vs prior fiscal_year; null for earliest year)" },
];

/** Per-year FX adjustments. PK is (company_id, fiscal_year). */
export const companyFxAdjustmentsSchema = [
  { name: "company_id", type: "uuid (FK companies.id)" },
  { name: "fiscal_year", type: "integer (1990..2100)" },
  { name: "currency", type: "text (ISO-4217, e.g. KRW)" },
  { name: "revenue_local", type: "numeric" },
  { name: "assumed_forex", type: "numeric (USD/local rate used)" },
  { name: "forex_change_vs_prior", type: "numeric (YoY % change in fx rate)" },
  { name: "revenue_cagr_domestic", type: "numeric (domestic CAGR vs prior)" },
];

/** 1:1 with companies. Holds L0/L1 screening-derived values. */
export const companyScreeningDerivedSchema = [
  { name: "company_id", type: "uuid (PK, FK companies.id)" },
  { name: "segment_revenue", type: "numeric" },
  { name: "segment_ebitda", type: "numeric" },
  { name: "segment_revenue_total_ratio", type: "numeric" },
  { name: "l0_revenue_2024_usd_mn", type: "numeric" },
  { name: "l0_ebitda_2024_usd_mn", type: "numeric" },
  { name: "l0_ev_2024_usd_mn", type: "numeric" },
  { name: "l0_ev_ebitda_2024", type: "numeric" },
  { name: "l0_ev_usd_mn", type: "numeric" },
  { name: "segment_specific_revenue_pct", type: "numeric" },
  { name: "combined_segment_revenue", type: "text" },
  { name: "revenue_from_priority_geo", type: "boolean" },
  { name: "pct_from_domestic", type: "numeric" },
  { name: "l1_revenue_cagr_l3y", type: "numeric" },
  { name: "l1_revenue_cagr_n3y", type: "numeric" },
  { name: "l1_revenue_drop_count", type: "integer" },
  { name: "l1_ebitda_below_threshold_count", type: "integer" },
  { name: "l1_vision_fit", type: "boolean" },
  { name: "l1_priority_geo", type: "boolean" },
  { name: "l1_ev_below_threshold", type: "boolean" },
  { name: "l1_revenue_no_consecutive_drop", type: "boolean" },
  { name: "l1_rationale", type: "text" },
  { name: "l1_screening_result", type: "l1_result (enum: pass, fail, inconclusive)" },
  { name: "fx_currency", type: "text" },
  { name: "fx_revenue_drop_count", type: "integer" },
  { name: "fx_revenue_no_consecutive_drop", type: "boolean" },
  { name: "fx_ebitda_above_10_l3y", type: "boolean" },
  { name: "fx_rationale", type: "text" },
];

export const invenCacheSchema = [
  // Inven-specific identifiers
  { name: "inven_company_id", type: "text" },
  { name: "domain", type: "text" },
  { name: "inven_company_name", type: "text" },
  { name: "website", type: "text" },
  { name: "linkedin", type: "text" },
  { name: "description", type: "text" },
  { name: "logo_url", type: "text" },
  // Headcount
  { name: "headcount_min", type: "integer" },
  { name: "headcount_max", type: "integer" },
  { name: "employee_count", type: "integer" },
  // Financial estimates
  { name: "revenue_estimate_usd_millions", type: "numeric" },
  // Company info
  { name: "ownership", type: "text" },
  { name: "founded_year", type: "integer" },
  { name: "headquarters_city", type: "text" },
  { name: "headquarters_state", type: "text" },
  { name: "headquarters_country_code", type: "text" },
  // Plus all companies columns for enrichment
  ...companiesSchema,
];
