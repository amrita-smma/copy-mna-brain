import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { type CountryCode, type SearchType } from "valyu-js";
import { executeValyuSearch, VALYU_COUNTRY_CODES } from "./valyu_search";

export interface TopicQueryConfig<T> {
  name: string;
  description: string;
  schema: z.ZodType<T>;
  buildQuery: (input: T) => {
    query: string;
    searchType?: SearchType;
    instructions?: string;
    startDate?: string;
    endDate?: string;
    countryCode?: CountryCode;
    includedSources?: string[];
    historicalCache?: boolean;
    topicHeader: string;
  };
}

/**
 * Shared factory to create a thin, fact-only VC topic research tool backed by Valyu.
 * Does not synthesize verdicts, score fit, or make investment decisions.
 * Returns raw source-separated evidence with citation metadata and fallback instructions.
 */
export function createValyuTopicResearchTool<T extends Record<string, unknown>>(
  config: TopicQueryConfig<T>,
) {
  return tool(
    async (input: T) => {
      const queryConfig = config.buildQuery(input);
      return executeValyuSearch({
        query: queryConfig.query,
        search_type: queryConfig.searchType || "all",
        included_sources: queryConfig.includedSources,
        instructions: queryConfig.instructions,
        start_date: queryConfig.startDate,
        end_date: queryConfig.endDate,
        country_code: queryConfig.countryCode,
        historical_cache: queryConfig.historicalCache,
        headerTitle: `External Evidence (${queryConfig.topicHeader})`,
        emptyMessage: `No Valyu results found for '${queryConfig.query}'. Consider using web_search as a fallback.`,
        toolName: config.name,
      });
    },
    {
      name: config.name,
      description: config.description,
      schema: config.schema,
    },
  );
}

// 1. get_company_profile
export const getCompanyProfileSchema = z.object({
  company_name: z
    .string()
    .trim()
    .min(1, "company_name is required")
    .describe("Name of the target company to research (e.g. 'Stripe', 'Databricks')"),
  query_focus: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Optional specific focus area (e.g. 'founders and leadership', 'business model and revenue', 'funding rounds and traction')",
    ),
  country_code: z
    .enum(VALYU_COUNTRY_CODES)
    .optional()
    .describe("Optional ISO country code filter (e.g. 'US', 'GB', 'ID') or 'ALL'"),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be in YYYY-MM-DD format")
    .optional()
    .describe("Optional start date filter in YYYY-MM-DD format"),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be in YYYY-MM-DD format")
    .optional()
    .describe("Optional end date filter in YYYY-MM-DD format"),
  included_sources: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe("Optional list of specific domains or source IDs to include (max 20)"),
  historical_cache: z
    .boolean()
    .optional()
    .describe("When true and a date range is set, returns newest cached snapshot inside the range"),
});

export type GetCompanyProfileInput = z.infer<typeof getCompanyProfileSchema>;

export const getCompanyProfile = createValyuTopicResearchTool<GetCompanyProfileInput>({
  name: "get_company_profile",
  description: `Gather external factual evidence on a company's background, founders, leadership team, business model, products, and disclosed funding history using Valyu search.

Returns factual evidence from external web, news, and proprietary sources with citations. Does not synthesize investment verdicts or calculate scores.

Args:
    company_name: Name of the target company to research.
    query_focus: Optional focus area (e.g. 'founders and leadership', 'business model', 'funding history').
    country_code: Optional ISO country code filter (e.g. 'US', 'GB', 'ID') or 'ALL'.
    start_date: Optional start date filter in YYYY-MM-DD format.
    end_date: Optional end date filter in YYYY-MM-DD format.
    included_sources: Optional list of specific domains or source IDs to include (max 20).
    historical_cache: Optional boolean for retrieving cached historical snapshots.

Returns:
    Factual external company profile evidence with source metadata and citations.`,
  schema: getCompanyProfileSchema,
  buildQuery: (input) => {
    const focus = input.query_focus?.trim();
    const query = focus
      ? `${input.company_name} ${focus}`
      : `${input.company_name} company profile overview business model founders team funding traction`;
    const instructions = focus
      ? `Focus on company profile and overview for ${input.company_name}, specifically: ${focus}.`
      : `Focus on company overview, founders, leadership team, business model, product traction, and disclosed funding history for ${input.company_name}.`;
    return {
      query,
      instructions,
      startDate: input.start_date,
      endDate: input.end_date,
      countryCode: input.country_code as CountryCode | undefined,
      includedSources: input.included_sources,
      historicalCache: input.historical_cache,
      topicHeader: `Company Profile for '${input.company_name}'`,
    };
  },
});

export const getCompanyProfileTool = getCompanyProfile;

// 2. get_sector_context
export const getSectorContextSchema = z.object({
  sector: z
    .string()
    .trim()
    .min(1, "sector is required")
    .describe(
      "Industry sector, technology vertical, or market domain (e.g. 'B2B SaaS in Southeast Asia', 'Defense Tech', 'Carbon Accounting')",
    ),
  query_focus: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Optional specific focus area (e.g. 'market sizing CAGR', 'growth drivers and tailwinds', 'headwinds', 'regulatory catalysts')",
    ),
  country_code: z
    .enum(VALYU_COUNTRY_CODES)
    .optional()
    .describe("Optional ISO country code filter (e.g. 'US', 'GB', 'ID') or 'ALL'"),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be in YYYY-MM-DD format")
    .optional()
    .describe("Optional start date filter in YYYY-MM-DD format"),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be in YYYY-MM-DD format")
    .optional()
    .describe("Optional end date filter in YYYY-MM-DD format"),
  included_sources: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe("Optional list of specific domains or source IDs to include (max 20)"),
  historical_cache: z
    .boolean()
    .optional()
    .describe("When true and a date range is set, returns newest cached snapshot inside the range"),
});

export type GetSectorContextInput = z.infer<typeof getSectorContextSchema>;

export const getSectorContext = createValyuTopicResearchTool<GetSectorContextInput>({
  name: "get_sector_context",
  description: `Gather external factual evidence on an industry sector or market vertical, including market sizing, growth rates (CAGR), secular trends, headwinds, and tailwinds using Valyu search.

Returns factual evidence from external sources with citations. Does not synthesize investment verdicts or calculate scores.

Args:
    sector: Industry sector, vertical, or market domain to research.
    query_focus: Optional focus area (e.g. 'market sizing CAGR', 'growth drivers', 'headwinds').
    country_code: Optional ISO country code filter.
    start_date: Optional start date filter in YYYY-MM-DD format.
    end_date: Optional end date filter in YYYY-MM-DD format.
    included_sources: Optional list of specific domains or source IDs to include (max 20).
    historical_cache: Optional boolean for retrieving cached historical snapshots.

Returns:
    Factual external sector and market context evidence with source metadata and citations.`,
  schema: getSectorContextSchema,
  buildQuery: (input) => {
    const focus = input.query_focus?.trim();
    const query = focus
      ? `${input.sector} ${focus}`
      : `${input.sector} market size industry growth trends CAGR headwinds tailwinds`;
    const instructions = focus
      ? `Focus on sector context for ${input.sector}, specifically: ${focus}.`
      : `Focus on market sizing, CAGR, industry drivers, secular trends, headwinds, tailwinds, and growth dynamics for ${input.sector}.`;
    return {
      query,
      instructions,
      startDate: input.start_date,
      endDate: input.end_date,
      countryCode: input.country_code as CountryCode | undefined,
      includedSources: input.included_sources,
      historicalCache: input.historical_cache,
      topicHeader: `Sector Context for '${input.sector}'`,
    };
  },
});

export const getSectorContextTool = getSectorContext;

// 3. get_competitor_landscape
export const getCompetitorLandscapeSchema = z.object({
  company_or_sector: z
    .string()
    .trim()
    .min(1, "company_or_sector is required")
    .describe("Target company name or market category to analyze competitor landscape for"),
  competitors: z
    .array(z.string().min(1))
    .max(10)
    .optional()
    .describe("Optional list of known competitor or peer company names to include in the landscape"),
  query_focus: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Optional specific focus area (e.g. 'differentiation and moat', 'pricing comparison', 'market share', 'feature matrix')",
    ),
  country_code: z
    .enum(VALYU_COUNTRY_CODES)
    .optional()
    .describe("Optional ISO country code filter (e.g. 'US', 'GB', 'ID') or 'ALL'"),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be in YYYY-MM-DD format")
    .optional()
    .describe("Optional start date filter in YYYY-MM-DD format"),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be in YYYY-MM-DD format")
    .optional()
    .describe("Optional end date filter in YYYY-MM-DD format"),
  included_sources: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe("Optional list of specific domains or source IDs to include (max 20)"),
  historical_cache: z
    .boolean()
    .optional()
    .describe("When true and a date range is set, returns newest cached snapshot inside the range"),
});

export type GetCompetitorLandscapeInput = z.infer<typeof getCompetitorLandscapeSchema>;

export const getCompetitorLandscape = createValyuTopicResearchTool<GetCompetitorLandscapeInput>({
  name: "get_competitor_landscape",
  description: `Gather external factual evidence on direct and indirect competitors, market positioning, alternative solutions, and differentiation for a company or market segment using Valyu search.

Returns factual evidence from external sources with citations. Does not synthesize investment verdicts or calculate scores.

Args:
    company_or_sector: Target company name or market category to analyze competitor landscape for.
    competitors: Optional list of known competitor or peer company names to include.
    query_focus: Optional focus area (e.g. 'differentiation and moat', 'pricing comparison', 'market share').
    country_code: Optional ISO country code filter.
    start_date: Optional start date filter in YYYY-MM-DD format.
    end_date: Optional end date filter in YYYY-MM-DD format.
    included_sources: Optional list of specific domains or source IDs to include (max 20).
    historical_cache: Optional boolean for retrieving cached historical snapshots.

Returns:
    Factual external competitor landscape evidence with source metadata and citations.`,
  schema: getCompetitorLandscapeSchema,
  buildQuery: (input) => {
    const focus = input.query_focus?.trim();
    const compStr = input.competitors && input.competitors.length > 0 ? ` ${input.competitors.join(" ")}` : "";
    const query = focus
      ? `${input.company_or_sector}${compStr} ${focus}`
      : `${input.company_or_sector}${compStr} competitors competitive landscape market share alternatives differentiation`;
    const instructions = focus
      ? `Focus on competitive landscape for ${input.company_or_sector}${input.competitors?.length ? ` (including ${input.competitors.join(", ")})` : ""}, specifically: ${focus}.`
      : input.competitors?.length
        ? `Focus on direct and indirect competitors, competitive positioning, alternatives, market share, and differentiation for ${input.company_or_sector} compared with ${input.competitors.join(", ")}.`
        : `Focus on direct and indirect competitors, competitive positioning, alternatives, market share, and differentiation for ${input.company_or_sector}.`;
    return {
      query,
      instructions,
      startDate: input.start_date,
      endDate: input.end_date,
      countryCode: input.country_code as CountryCode | undefined,
      includedSources: input.included_sources,
      historicalCache: input.historical_cache,
      topicHeader: `Competitor Landscape for '${input.company_or_sector}'`,
    };
  },
});

export const getCompetitorLandscapeTool = getCompetitorLandscape;

// 4. get_regulatory_context
export const getRegulatoryContextSchema = z.object({
  topic_or_sector: z
    .string()
    .trim()
    .min(1, "topic_or_sector is required")
    .describe(
      "Industry, technology vertical, business model, or company with regulatory scope (e.g. 'Crypto Custody', 'Autonomous Vehicles', 'Cross-Border Payments')",
    ),
  jurisdiction: z
    .string()
    .max(100)
    .optional()
    .describe(
      "Optional specific jurisdiction, country, or regulatory agency (e.g. 'US SEC', 'EU AI Act', 'Indonesia OJK', 'Singapore MAS')",
    ),
  query_focus: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Optional specific focus area (e.g. 'compliance requirements', 'licensing', 'enforcement actions', 'pending legislation')",
    ),
  country_code: z
    .enum(VALYU_COUNTRY_CODES)
    .optional()
    .describe("Optional ISO country code filter (e.g. 'US', 'GB', 'ID') or 'ALL'"),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be in YYYY-MM-DD format")
    .optional()
    .describe("Optional start date filter in YYYY-MM-DD format"),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be in YYYY-MM-DD format")
    .optional()
    .describe("Optional end date filter in YYYY-MM-DD format"),
  included_sources: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe("Optional list of specific domains or source IDs to include (max 20)"),
  historical_cache: z
    .boolean()
    .optional()
    .describe("When true and a date range is set, returns newest cached snapshot inside the range"),
});

export type GetRegulatoryContextInput = z.infer<typeof getRegulatoryContextSchema>;

export const getRegulatoryContext = createValyuTopicResearchTool<GetRegulatoryContextInput>({
  name: "get_regulatory_context",
  description: `Gather external factual evidence on regulatory frameworks, compliance obligations, licensing requirements, and jurisdictional rules for an industry, technology, or business model using Valyu search.

Returns factual evidence from external sources with citations. Does not synthesize investment verdicts or calculate scores.

Args:
    topic_or_sector: Industry, technology, business model, or company with regulatory scope.
    jurisdiction: Optional specific jurisdiction, country, or regulatory agency (e.g. 'US SEC', 'EU AI Act').
    query_focus: Optional focus area (e.g. 'compliance requirements', 'licensing', 'pending legislation').
    country_code: Optional ISO country code filter.
    start_date: Optional start date filter in YYYY-MM-DD format.
    end_date: Optional end date filter in YYYY-MM-DD format.
    included_sources: Optional list of specific domains or source IDs to include (max 20).
    historical_cache: Optional boolean for retrieving cached historical snapshots.

Returns:
    Factual external regulatory and compliance evidence with source metadata and citations.`,
  schema: getRegulatoryContextSchema,
  buildQuery: (input) => {
    const focus = input.query_focus?.trim();
    const jurTrim = input.jurisdiction?.trim();
    const jurStr = jurTrim ? ` ${jurTrim}` : "";
    const query = focus
      ? `${input.topic_or_sector}${jurStr} ${focus}`
      : `${input.topic_or_sector}${jurStr} regulatory framework compliance legal requirements licensing rules`;
    const instructions = focus
      ? `Focus on regulatory and legal context for ${input.topic_or_sector}${jurTrim ? ` in ${jurTrim}` : ""}, specifically: ${focus}.`
      : `Focus on regulatory requirements, legal frameworks, compliance obligations, licensing rules, and regulatory developments for ${input.topic_or_sector}${jurTrim ? ` in ${jurTrim}` : ""}.`;
    return {
      query,
      instructions,
      startDate: input.start_date,
      endDate: input.end_date,
      countryCode: input.country_code as CountryCode | undefined,
      includedSources: input.included_sources,
      historicalCache: input.historical_cache,
      topicHeader: `Regulatory Context for '${input.topic_or_sector}'${jurTrim ? ` (${jurTrim})` : ""}`,
    };
  },
});

export const getRegulatoryContextTool = getRegulatoryContext;

// 5. get_market_signals
export const getMarketSignalsSchema = z.object({
  entity_or_topic: z
    .string()
    .trim()
    .min(1, "entity_or_topic is required")
    .describe("Company name, executive, or sector topic to monitor external market signals for"),
  signal_type: z
    .enum(["all", "news", "funding", "hiring", "leadership", "partnerships", "product"])
    .optional()
    .default("all")
    .describe(
      "Signal category filter: 'all', 'news', 'funding', 'hiring', 'leadership', 'partnerships', 'product' (default: 'all')",
    ),
  query_focus: z
    .string()
    .max(500)
    .optional()
    .describe(
      "Optional specific focus area (e.g. 'executive turnover', 'Series B funding', 'new enterprise customers', 'litigation')",
    ),
  country_code: z
    .enum(VALYU_COUNTRY_CODES)
    .optional()
    .describe("Optional ISO country code filter (e.g. 'US', 'GB', 'ID') or 'ALL'"),
  start_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be in YYYY-MM-DD format")
    .optional()
    .describe("Optional start date filter in YYYY-MM-DD format"),
  end_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be in YYYY-MM-DD format")
    .optional()
    .describe("Optional end date filter in YYYY-MM-DD format"),
  included_sources: z
    .array(z.string().min(1))
    .max(20)
    .optional()
    .describe("Optional list of specific domains or source IDs to include (max 20)"),
  historical_cache: z
    .boolean()
    .optional()
    .describe("When true and a date range is set, returns newest cached snapshot inside the range"),
});

export type GetMarketSignalsInput = z.infer<typeof getMarketSignalsSchema>;

export const getMarketSignals = createValyuTopicResearchTool<GetMarketSignalsInput>({
  name: "get_market_signals",
  description: `Gather external factual evidence on recent market signals, news developments, leadership changes, funding rounds, partnerships, and traction for a company or sector using Valyu search.

Returns factual evidence from external sources with citations. Does not synthesize investment verdicts or calculate scores.

Args:
    entity_or_topic: Company name, executive, or sector topic to monitor external market signals for.
    signal_type: Optional signal category filter ('all', 'news', 'funding', 'hiring', 'leadership', 'partnerships', 'product', default 'all').
    query_focus: Optional focus area (e.g. 'executive turnover', 'Series B funding', 'new enterprise customers').
    country_code: Optional ISO country code filter (e.g. 'US', 'GB', 'ID') or 'ALL'.
    start_date: Optional start date filter in YYYY-MM-DD format.
    end_date: Optional end date filter in YYYY-MM-DD format.
    included_sources: Optional list of specific domains or source IDs to include (max 20).
    historical_cache: Optional boolean for retrieving cached historical snapshots.

Returns:
    Factual external market signals evidence with source metadata and citations.`,
  schema: getMarketSignalsSchema,
  buildQuery: (input) => {
    const focus = input.query_focus?.trim();
    const signalType = input.signal_type || "all";
    const signalFocus = signalType !== "all" ? `${signalType} ` : "";
    const query = focus
      ? `${input.entity_or_topic} ${signalFocus}${focus}`
      : `${input.entity_or_topic} ${signalFocus}recent news announcements funding hiring leadership partnerships product launches`;
    const instructions = focus
      ? `Focus on market signals for ${input.entity_or_topic}${signalType !== "all" ? ` (${signalType})` : ""}, specifically: ${focus}.`
      : `Focus on recent external market signals, news events, leadership changes, funding announcements, partnerships, and traction for ${input.entity_or_topic}${signalType !== "all" ? ` specifically regarding ${signalType}` : ""}.`;
    return {
      query,
      searchType: signalType === "news" ? "news" : "all",
      instructions,
      startDate: input.start_date,
      endDate: input.end_date,
      countryCode: input.country_code as CountryCode | undefined,
      includedSources: input.included_sources,
      historicalCache: input.historical_cache,
      topicHeader: `Market Signals for '${input.entity_or_topic}'${signalType !== "all" ? ` [${signalType}]` : ""}`,
    };
  },
});

export const getMarketSignalsTool = getMarketSignals;
