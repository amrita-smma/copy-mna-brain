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
import { listPipelineStages } from "./list_pipeline_stages";
import { lookupCrm } from "./lookup_crm";
import { crmInsights } from "./crm_insights";
import { SERVER_TOOLS } from "./server_tools";
import { valyuSearch } from "./valyu_search";
// AlphaSense is retired: the subscription is no longer in use, so
// `alphasense_search` is not registered with any agent and no tool list
// below includes it. The tool is still exported (and tested) so it can be
// put back in a list if the subscription ever returns.
import { alphasenseSearch } from "./alphasense_search";
import { queryMeetingNotes } from "./query_files";
import { proposeWorkforceHandoff } from "./propose_workforce_handoff";
import { searchChatHistory } from "./search_chat_history";
import { lookupBot } from "./lookup_bot";
import { proposeCreateBot } from "./propose_create_bot";
import { updateBot } from "./update_bot";
import { listTasks } from "./list_tasks";
import { createTask } from "./create_task";
import { updateTask } from "./update_task";
import { deleteTask } from "./delete_task";
import { listRoutines } from "./list_routines";
import { proposeCreateRoutine } from "./propose_create_routine";
import { updateRoutine } from "./update_routine";
import { deleteRoutine } from "./delete_routine";
import { offerOptions } from "./offer_options";
import { proposeBulkDropCompanies } from "./propose_bulk_drop_companies";
import { proposeBulkPromoteCompanies } from "./propose_bulk_promote_companies";
import { moveStage } from "./move_stage";
import { askOwner } from "./ask_owner";
import { lookupPipelineStage } from "./lookup_pipeline_stage";
import { dropCompany } from "./drop_company";
import { addCompany } from "./add_company";
import { updateCompanyRelationship } from "./update_company_relationship";
import { generateRelationshipGraph } from "./generate_relationship_graph";
import { readRelationshipGraph } from "./read_relationship_graph";
import { generateCompanyCard } from "./generate_company_card";
import { runAiScreening } from "./run_ai_screening";
import { updateCompanyCardSection } from "./update_company_card_section";
import { updateCompanyDetails } from "./update_company_details";
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
import { queryLedgerEntries } from "./query_ledger_entries";
import { searchInvestments } from "./search_investments";
import { getInvestmentTheses } from "./get_investment_theses";
import { calculateInvestmentReturns } from "./calculate_investment_returns";
import { financialEquityAnalysis } from "./financial_equity_analysis";
import { valyuExtractContent } from "./valyu_extract_content";
import { getCompanyProfile } from "./get_company_profile";
import { getSectorContext } from "./get_sector_context";
import { getCompetitorLandscape } from "./get_competitor_landscape";
import { getRegulatoryContext } from "./get_regulatory_context";
import { getMarketSignals } from "./get_market_signals";
import { navigatePage } from "./navigate_page";
import { readPageContext } from "./read_page_context";
import { getInsight } from "./get_insight";
import { getInsightTemplate } from "./get_insight_template";
import { proposeInsightCreate } from "./propose_insight_create";
import { proposeInsightEdit } from "./propose_insight_edit";
import { proposeInsightRefresh } from "./propose_insight_refresh";
import { proposeReportPlan } from "./propose_report_plan";
import { createInsight } from "./create_insight";
import { editInsightSection } from "./edit_insight_section";
import { replaceInsightDocument } from "./replace_insight_document";

export { searchChatHistory, lookupBot, proposeCreateBot, updateBot, listRoutines, proposeCreateRoutine, updateRoutine, deleteRoutine, offerOptions };
export { listTasks, createTask, updateTask, deleteTask };

export {
  getDataSchema,
  queryCompanies,
  getCompanyStats,
  getCompanyDetails,
  analyzeStalledDeals,
  listPipelineStages,
  lookupCrm,
  crmInsights,
  SERVER_TOOLS,
  valyuSearch,
  alphasenseSearch,
  queryMeetingNotes,
  proposeWorkforceHandoff,
  proposeBulkDropCompanies,
  proposeBulkPromoteCompanies,
  moveStage,
  askOwner,
  lookupPipelineStage,
  addCompany,
  updateCompanyRelationship,
  generateRelationshipGraph,
  readRelationshipGraph,
  generateCompanyCard,
  updateCompanyCardSection,
  updateCompanyDetails,
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
  queryLedgerEntries,
  searchInvestments,
  getInvestmentTheses,
  calculateInvestmentReturns,
  financialEquityAnalysis,
  valyuExtractContent,
  getCompanyProfile,
  getSectorContext,
  getCompetitorLandscape,
  getRegulatoryContext,
  getMarketSignals,
  navigatePage,
  readPageContext,
  getInsight,
  getInsightTemplate,
  proposeInsightCreate,
  proposeInsightEdit,
  proposeInsightRefresh,
  proposeReportPlan,
  createInsight,
  editInsightSection,
  replaceInsightDocument,
};

export {
  companiesSchema,
  companyFinancialsSchema,
  companyFxAdjustmentsSchema,
  companyScreeningDerivedSchema,
} from "./schemas";

export type { AnthropicServerTool } from "./server_tools";

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
  getInvestmentTheses,
  analyzeStalledDeals,
  listPipelineStages,
  lookupCrm,
  crmInsights,
  ...SERVER_TOOLS,
  queryMeetingNotes,
  readRelationshipGraph,
  getTaskProgress,
  lookupUser,
  getInsightTemplate,
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
 *
 * propose_insight_create is deliberately absent from every chat list: a new
 * insight is always generated by the Workforce (via propose_workforce_handoff),
 * which builds it section by section and emails the requester a link when it
 * is published. The tool stays exported so past chat transcripts that carry
 * its approval card still render.
 */
export const chatOnlyTools = [
  proposeWorkforceHandoff,
  proposeBulkDropCompanies,
  proposeBulkPromoteCompanies,
  sendEmailTool,
  updateCompanyCardSection,
  navigatePage,
  readPageContext,
  getInsight,
  proposeInsightEdit,
  proposeInsightRefresh,
  proposeReportPlan,
];

/**
 * Bot tools — in no flavour's list. A Copilot bot gets them per turn through
 * its skills (`@/lib/bots/skills`): history search and option cards for every bot, the rest via
 * the bot_builder, routines and tasks skills. They read the chatting user from
 * the turn's `configurable`, so they only work inside a bot chat.
 */
export const botTools = [
  searchChatHistory,
  lookupBot,
  proposeCreateBot,
  updateBot,
  listRoutines,
  proposeCreateRoutine,
  updateRoutine,
  deleteRoutine,
  offerOptions,
  listTasks,
  createTask,
  updateTask,
  deleteTask,
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
  lookupPipelineStage,
  moveStage,
  addCompany,
  updateCompanyDetails,
  updateCompanyRelationship,
  generateRelationshipGraph,
  generateCompanyCard,
  runAiScreening,
  saveAiOpinion,
  saveFundAiOpinion,
  runMarketScreeningTool,
  narrateStep,
  reportProgress,
  notifyProgress,
  flagInsight,
  sendEmailTool,
  dropCompany,
  createInsight,
  editInsightSection,
  getInsight,
  replaceInsightDocument,
  askOwner,
];

/**
 * Investment tools — the read-only fund/investing tool set for the
 * "investment" Copilot flavor. Lets the agent see and analyze the workspace's
 * funds, assets/holdings, investors (LPs), and fund sources, plus web search
 * and Valyu search for external market data. Distinct from the M&A tool set
 * (companies/CRM) otherwise; `valyu_search` is added directly to the M&A
 * chat's `DEFAULT_TOOL_LIST` in index.ts and is listed here too because this
 * flavor does not spread the shared `tools` base.
 */
export const investmentTools = [
  getFundDataSchema,
  searchInvestments,
  queryFunds,
  queryFundAssets,
  getFundAssetDetails,
  queryInvestors,
  queryFundSources,
  queryLedgerEntries,
  ...SERVER_TOOLS,
  valyuSearch,
  queryMeetingNotes,
  lookupCrm,
  crmInsights,
  lookupUser,
  sendEmailTool,
  proposeWorkforceHandoff,
  navigatePage,
  readPageContext,
  getInsight,
  getInsightTemplate,
  proposeInsightEdit,
  proposeInsightRefresh,
  proposeReportPlan,
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
  queryLedgerEntries,
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
  ...SERVER_TOOLS,
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
  getInsight,
  getInsightTemplate,
  proposeInsightEdit,
  proposeInsightRefresh,
  proposeReportPlan,
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
        "Search and filter companies by ANY companies column (segment, geography, stage, source, status, deal type, sponsor/captain/banker/advisor, ownership, workflow status, NBO date, live status, revenue/EBITDA, AI Opinion, timestamps, ...) plus relationship-graph filters (connected_to / relation_type / has_relationships). Returns each row's company id — pass those ids to send_email's company_excel / company_card to export exactly what you listed. Use include_pre_pipeline=true to search all stages including intake/discovery",
    },
    {
      name: "get_company_stats",
      description:
        "Aggregate summary of a cohort scoped by the SAME filters as query_companies: counts, active/dropped & inbound/outbound splits, revenue/EBITDA totals/averages/medians, AI Opinion coverage, and breakdowns by segment/geography/stage/source/status/ownership/deal_type/ai_opinion",
    },
    {
      name: "get_company_details",
      description: "Get detailed information about a specific company by name",
    },
    {
      name: "get_investment_theses",
      description:
        "Read the workspace's investment theses — the firm's active investment mandate (sector, geography, deal size, deal type scope). Use it to judge whether a company is inside or outside mandate before forming a view on it",
    },
    {
      name: "analyze_stalled_deals",
      description:
        "Analyze active deals stuck in the same pipeline stage for too long (default 2+ weeks): summary count, a table of stalled deals by days-in-stage, per-deal stage timelines, and the remaining within-threshold actives",
    },
    {
      name: "list_pipeline_stages",
      description:
        "List the workspace's pipeline stages in order — code, name and key. Workspaces rename, reorder, add and delete stages, so read this before filtering by a stage the user names and pass its key",
    },
    {
      name: "lookup_crm",
      description:
        "Look up CRM firms and bankers. By name/email: the firm's full relationship picture (bankers, topics, team coverage, recent emails, notes, linked pipeline companies). By deal profile (geography + deal_type + department): individual bankers ranked by fit, for 'which banker can help me close this deal'",
    },
    {
      name: "crm_insights",
      description:
        "Get portfolio-wide CRM health metrics: stale relationships, flagged records awaiting curation, and emails received today",
    },
    {
      name: "query_ledger_entries",
      description:
        "Read the fund ledger row by row — every posted movement (commitment, capital call, buy, sell, distribution, redemption, transfer, income, expense, adjustment) against the position holding it, with signed commitment/quantity/cash deltas, funding attribution, and reversals",
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
        "Resolve a user in the active workspace by a name or email fragment, returning only their name and email — used to find a recipient's address before sending email",
    },
    {
      name: "send_email",
      description:
        "Send ONE email (subject + body) to the signed-in user or named platform users, optionally attaching a comprehensive company Excel (.xlsx) export, a Company Card deck (.pptx), and/or a formatted research-summary PDF in the same message. Run query_companies FIRST and pass the ids it returned as company_ids so the attachments cover exactly the rows you showed; recipients are restricted to registered platform users",
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
    {
      name: "get_insight",
      description:
        "Read an insight's current HTML document; call before propose_insight_edit",
    },
    {
      name: "get_insight_template",
      description:
        "Read an insight template's HTML by id or name — for a template named in plain text or a template_id from a handoff; a template attached to the message is already in it",
    },
    {
      name: "propose_insight_edit",
      description:
        "Propose editing an existing insight (complete updated HTML document) via an approval card",
    },
    {
      name: "propose_report_plan",
      description:
        "Propose a methodology and clarifying questions for a report before researching or building it, via an approval card",
    },
  ];

  return toolInfo
    .map((t, i) => `${i + 1}. **${t.name}** - ${t.description}`)
    .join("\n");
}
