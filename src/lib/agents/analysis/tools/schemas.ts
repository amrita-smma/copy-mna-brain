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
  { name: "segment", type: "text (broad sector/segment category, e.g. \"Semiconductor\", \"Upstream Palm Oil\" — not a hyper-specific niche or a long descriptive clause; always in English)" },
  { name: "segment_related_offerings", type: "text" },
  { name: "company_focus", type: "text" },
  { name: "website", type: "text" },
  { name: "watchlist_status", type: "text" },
  { name: "pipeline_stage", type: "text (stage key: market_screening, unreviewed, discovered, L0–L5, or a key the workspace added such as stg-3f9a1c2e — list_pipeline_stages maps keys to the codes/names users see)" },
  { name: "comments", type: "text" },
  { name: "ownership", type: "text" },
  { name: "geography", type: "text (headquarters country — EXACTLY ONE country name, e.g. \"United States\"; never a region, a city, or multiple countries; always in English)" },
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
