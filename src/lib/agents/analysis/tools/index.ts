/**
 * Tool registry for the analysis agent.
 * Each tool lives in its own file; this module aggregates them into the
 * `tools` array consumed by `createAgent` in ../index.ts.
 */
import { getDataSchema } from "./get_data_schema";
import { queryCompanies } from "./query_companies";
import { getCompanyStats } from "./get_company_stats";
import { getCompanyDetails } from "./get_company_details";
import { analyzeStalledDeals } from "./analyze_stalled_deals";
import { lookupCrm } from "./lookup_crm";
import { crmInsights } from "./crm_insights";
import { webSearch } from "./web_search";
import { valyuSearch } from "./valyu_search";
import { queryMeetingNotes } from "./query_files";
import { proposeWorkforceHandoff } from "./propose_workforce_handoff";
import { proposeBulkDropCompanies } from "./propose_bulk_drop_companies";
import { proposeBulkPromoteCompanies } from "./propose_bulk_promote_companies";
import { promoteToL1 } from "./promote_to_l1";
import { promoteToL0 } from "./promote_to_l0";
import { dropCompany } from "./drop_company";
import { addCompany } from "./add_company";
import { updateCompanyRelationship } from "./update_company_relationship";
import { generateRelationshipGraph } from "./generate_relationship_graph";
import { readRelationshipGraph } from "./read_relationship_graph";
import { generateCompanyCard } from "./generate_company_card";
import { updateCompanyCardSection } from "./update_company_card_section";
import { saveAiOpinion } from "./save_ai_opinion";
import { saveFundAiOpinion } from "./save_fund_ai_opinion";
import { narrateStep } from "./narrate_step";
import { reportProgress } from "./report_progress";
import { notifyProgress } from "./notify_progress";
import { flagInsight } from "./flag_insight";
import { getTaskProgress } from "./get_task_progress";
import { lookupUser } from "./lookup_user";
import { sendEmailTool } from "./send_email";
import { runMarketScreeningTool } from "./run_market_screening";
import { getFundDataSchema } from "./get_fund_data_schema";
import { queryFunds } from "./query_funds";
import { queryFundAssets } from "./query_fund_assets";
import { getFundAssetDetails } from "./get_fund_asset_details";
import { queryInvestors } from "./query_investors";
import { queryFundSources } from "./query_fund_sources";
import { searchInvestments } from "./search_investments";
import { getInvestmentTheses } from "./get_investment_theses";
import { calculateInvestmentReturns } from "./calculate_investment_returns";
import { valyuExtractContent } from "./valyu_extract_content";
import { getCompanyProfile } from "./get_company_profile";
import { getSectorContext } from "./get_sector_context";
import { getCompetitorLandscape } from "./get_competitor_landscape";
import { getRegulatoryContext } from "./get_regulatory_context";
import { getMarketSignals } from "./get_market_signals";
import { navigatePage } from "./navigate_page";
import { readPageContext } from "./read_page_context";

export {
  getDataSchema,
  queryCompanies,
  getCompanyStats,
  getCompanyDetails,
  analyzeStalledDeals,
  lookupCrm,
  crmInsights,
  webSearch,
  valyuSearch,
  queryMeetingNotes,
  proposeWorkforceHandoff,
  proposeBulkDropCompanies,
  proposeBulkPromoteCompanies,
  promoteToL1,
  promoteToL0,
  addCompany,
  updateCompanyRelationship,
  generateRelationshipGraph,
  readRelationshipGraph,
  generateCompanyCard,
  updateCompanyCardSection,
  saveAiOpinion,
  saveFundAiOpinion,
  narrateStep,
  reportProgress,
  notifyProgress,
  flagInsight,
  getTaskProgress,
  lookupUser,
  sendEmailTool,
  runMarketScreeningTool,
  getFundDataSchema,
  queryFunds,
  queryFundAssets,
  getFundAssetDetails,
  queryInvestors,
  queryFundSources,
  searchInvestments,
  getInvestmentTheses,
  calculateInvestmentReturns,
  valyuExtractContent,
  getCompanyProfile,
  getSectorContext,
  getCompetitorLandscape,
  getRegulatoryContext,
  getMarketSignals,
  navigatePage,
  readPageContext,
};

export {
  companiesSchema,
  companyFinancialsSchema,
  companyFxAdjustmentsSchema,
  companyScreeningDerivedSchema,
} from "./schemas";

/**
 * Base tools — safe for any agent context, including the workforce itself.
 * Read-only data/web tools. Anything added here is callable by workforce
 * runs too.
 */
export const tools = [
  getDataSchema,
  queryCompanies,
  getCompanyStats,
  getCompanyDetails,
  analyzeStalledDeals,
  lookupCrm,
  crmInsights,
  webSearch,
  queryMeetingNotes,
  readRelationshipGraph,
  getTaskProgress,
  lookupUser,
];

/**
 * Chat-only tools — available to the copilot chat agent but NOT to the
 * workforce agent. propose_workforce_handoff lives here so workforce runs
 * cannot recursively spawn child workforce tasks (the v1
 * single-workforce-step invariant), and so a workforce agent doesn't waste
 * tokens emitting handoff cards that have no UI to render them.
 *
 * navigate_page and read_page_context are chat-only for the same reason: both
 * assume a browser the workforce doesn't have. A workforce run has no center
 * console to move and nobody looking at a page.
 */
export const chatOnlyTools = [
  proposeWorkforceHandoff,
  proposeBulkDropCompanies,
  proposeBulkPromoteCompanies,
  sendEmailTool,
  updateCompanyCardSection,
  navigatePage,
  readPageContext,
];

/**
 * Workforce-only tools — write actions available to the workforce agent
 * but NOT to chat. Chat never writes directly; users approve writes via
 * propose_workforce_handoff, which enqueues a workforce row that uses
 * these tools to actually mutate state.
 *
 * narrate_step is a no-op trace-card tool: the workforce agent calls it
 * once per model turn to emit structured title/overview/detailed for the
 * Reasoning trace UI in /ai-workforce/tasks/{id}. Excluded from chat
 * because the chat UI has no trace renderer.
 *
 * report_progress is the iteration-snapshot equivalent: when the agent is
 * working through a list of N candidates, it re-emits the full items list
 * each turn with per-item status (pending / checking / done / fail). The
 * trace UI renders this as a "Live · partial output" block on the current
 * step. Same chat-exclusion rationale as narrate_step.
 */
export const workforceOnlyTools = [
  promoteToL0,
  promoteToL1,
  addCompany,
  updateCompanyRelationship,
  generateRelationshipGraph,
  generateCompanyCard,
  saveAiOpinion,
  saveFundAiOpinion,
  runMarketScreeningTool,
  narrateStep,
  reportProgress,
  notifyProgress,
  flagInsight,
  sendEmailTool,
  dropCompany,
];

/**
 * Investment tools — the read-only fund/investing tool set for the
 * "investment" Copilot flavor. Lets the agent see and analyze the workspace's
 * funds, assets/holdings, investors (LPs), and fund sources, plus web search
 * and Valyu search for external market data. Distinct from the M&A tool set
 * (companies/CRM) otherwise; `valyu_search` is the one tool shared with the
 * M&A chat flavor (added directly to `DEFAULT_TOOL_LIST` in index.ts).
 */
export const investmentTools = [
  getFundDataSchema,
  searchInvestments,
  queryFunds,
  queryFundAssets,
  getFundAssetDetails,
  queryInvestors,
  queryFundSources,
  webSearch,
  valyuSearch,
  queryMeetingNotes,
  lookupCrm,
  crmInsights,
  lookupUser,
  sendEmailTool,
  proposeWorkforceHandoff,
  navigatePage,
  readPageContext,
];

/**
 * Combined tools — the "combined" Copilot flavor sees BOTH the M&A/acquisitions
 * tool set (base + chat-only: companies, CRM, deal analysis, bulk actions,
 * email) AND the read-only fund/investing tools (funds, assets, investors, fund
 * sources). It is the union of DEFAULT_TOOL_LIST (`tools` + `chatOnlyTools`) and
 * `investmentTools`, deduplicated: the fund tools listed below are the only
 * entries `investmentTools` adds that the M&A lists don't already contain
 * (web_search, query_files, lookup_crm, crm_insights, lookup_user, send_email,
 * propose_workforce_handoff are shared and must not be duplicated — passing the
 * same tool twice to createAgent would register a duplicate name).
 * `valyu_search` isn't part of the shared `tools` or `chatOnlyTools` lists
 * (it's added directly to the M&A chat's `DEFAULT_TOOL_LIST` in index.ts
 * instead), so it's listed explicitly here too.
 */
export const combinedTools = [
  ...tools,
  ...chatOnlyTools,
  getFundDataSchema,
  searchInvestments,
  queryFunds,
  queryFundAssets,
  getFundAssetDetails,
  queryInvestors,
  queryFundSources,
  valyuSearch,
];

/**
 * VC tools — the curated tool set for the "vc" (Venture Capital / Growth Equity)
 * Copilot flavor. Combines M&A pipeline companies, workspace investment theses,
 * fund portfolio data, CRM context, web and Valyu research, deterministic
 * return calculations, and workforce/communication actions.
 */
export const vcTools = [
  getDataSchema,
  queryCompanies,
  getCompanyStats,
  getCompanyDetails,
  getInvestmentTheses,
  getFundDataSchema,
  searchInvestments,
  queryFunds,
  queryFundAssets,
  getFundAssetDetails,
  queryInvestors,
  queryFundSources,
  queryMeetingNotes,
  lookupCrm,
  crmInsights,
  webSearch,
  valyuSearch,
  valyuExtractContent,
  getCompanyProfile,
  getSectorContext,
  getCompetitorLandscape,
  getRegulatoryContext,
  getMarketSignals,
  calculateInvestmentReturns,
  lookupUser,
  sendEmailTool,
  proposeWorkforceHandoff,
  navigatePage,
  readPageContext,
];

/**
 * Get a formatted list of tool names and descriptions for prompt injection.
 * Returns a markdown-formatted list of available tools.
 */
export function getToolDescriptions(): string {
  const toolInfo = [
    {
      name: "get_data_schema",
      description:
        "Get the database schema to understand available columns and data types",
    },
    {
      name: "query_companies",
      description:
        "Search and filter companies by segment, geography, stage, source, status, deal type, sponsor, banker, ownership, revenue/EBITDA, and AI Opinion (use include_pre_pipeline=true to search all stages including intake/discovery)",
    },
    {
      name: "get_company_stats",
      description:
        "Aggregate summary of a filtered cohort: counts, active/dropped & inbound/outbound splits, revenue/EBITDA totals/averages/medians, AI Opinion coverage, and breakdowns by segment/geography/stage/source/status/ownership/deal_type/ai_opinion",
    },
    {
      name: "get_company_details",
      description: "Get detailed information about a specific company by name",
    },
    {
      name: "analyze_stalled_deals",
      description:
        "Analyze active deals stuck in the same pipeline stage for too long (default 2+ weeks): summary count, a table of stalled deals by days-in-stage, per-deal stage timelines, and the remaining within-threshold actives",
    },
    {
      name: "lookup_crm",
      description:
        "Look up a CRM firm/banker by name or email and get its full relationship picture — bankers, topics, team coverage, recent emails, notes, and linked pipeline companies",
    },
    {
      name: "crm_insights",
      description:
        "Get portfolio-wide CRM health metrics: stale relationships, flagged records awaiting curation, and emails received today",
    },
    {
      name: "web_search",
      description:
        "Search the web for company data, financials, market info, and external benchmarks",
    },
    {
      name: "valyu_search",
      description:
        "Search Valyu.ai across the web and proprietary data sources (financial filings, market data, research, news) for deeper investment/diligence research with citations",
    },
    {
      name: "query_files",
      description:
        "Search and retrieve files related to companies, tags, or topics",
    },
    {
      name: "read_relationship_graph",
      description:
        "Read the company relationship graph (Neo4j): list what a single company is connected to, or check every pair among a list of companies for a direct connection",
    },
    {
      name: "get_task_progress",
      description:
        "Check the status and progress of recent AI Workforce tasks (filter by status or agent_name)",
    },
    {
      name: "propose_workforce_handoff",
      description:
        "Offer to send a write-heavy request (including L0→L1 promotions) to the AI Workforce via a confirmation card",
    },
    {
      name: "propose_bulk_drop_companies",
      description:
        "Propose dropping a batch of stale or out-of-mandate companies via an approval card with checkboxes",
    },
    {
      name: "propose_bulk_promote_companies",
      description:
        "Propose promoting a batch of L0 companies to L1 (or any stage) via an approval card with checkboxes, tags, and inline signals",
    },
    {
      name: "lookup_user",
      description:
        "Resolve a platform user by a name or email fragment, returning only their name and email — used to find a recipient's address before sending email",
    },
    {
      name: "send_email",
      description:
        "Send ONE email (subject + body) to the signed-in user or named platform users, optionally attaching a comprehensive company Excel (.xlsx) export and/or a formatted research-summary PDF in the same message; recipients are restricted to registered platform users",
    },
    {
      name: "update_company_card_section",
      description:
        "Overwrite a single section (e.g. business overview, investment thesis, risks) of a company's AI Company Card / Overview slide with rewritten markdown",
    },
    {
      name: "navigate_page",
      description:
        "Move the center console to another page in the app (dashboard, pipeline, fund management, master data, CRM, smart files, presentation, AI workspace, company graph) without leaving the conversation",
    },
    {
      name: "read_page_context",
      description:
        "Find out which page the user is currently looking at and what is on it (the open record, the active filters) — call this before answering any request that says \"this page\", \"this deal\", or \"these results\"",
    },
  ];

  return toolInfo
    .map((t, i) => `${i + 1}. **${t.name}** - ${t.description}`)
    .join("\n");
}
