/**
 * Tool registry for the analysis agent.
 * Each tool lives in its own file; this module aggregates them into the
 * `tools` array consumed by `createAgent` in ../index.ts.
 */
import { getDataSchema } from "./get_data_schema";
import { queryCompanies } from "./query_companies";
import { getCompanyStats } from "./get_company_stats";
import { getCompanyDetails } from "./get_company_details";
import { webSearch } from "./web_search";
import { queryPastAcquisitions } from "./query_past_acquisitions";
import { compareWithPastAcquisitions } from "./compare_with_past_acquisitions";
import { getPastAcquisitionDetails } from "./get_past_acquisition_details";
import { queryMeetingNotes } from "./query_files";
import { proposeWorkforceHandoff } from "./propose_workforce_handoff";
import { promoteToL1 } from "./promote_to_l1";

export {
  getDataSchema,
  queryCompanies,
  getCompanyStats,
  getCompanyDetails,
  webSearch,
  queryPastAcquisitions,
  compareWithPastAcquisitions,
  getPastAcquisitionDetails,
  queryMeetingNotes,
  proposeWorkforceHandoff,
  promoteToL1,
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
  webSearch,
  queryPastAcquisitions,
  compareWithPastAcquisitions,
  getPastAcquisitionDetails,
  queryMeetingNotes,
];

/**
 * Chat-only tools — available to the copilot chat agent but NOT to the
 * workforce agent. propose_workforce_handoff lives here so workforce runs
 * cannot recursively spawn child workforce tasks (the v1
 * single-workforce-step invariant), and so a workforce agent doesn't waste
 * tokens emitting handoff cards that have no UI to render them.
 */
export const chatOnlyTools = [proposeWorkforceHandoff];

/**
 * Workforce-only tools — write actions available to the workforce agent
 * but NOT to chat. Chat never writes directly; users approve writes via
 * propose_workforce_handoff, which enqueues a workforce row that uses
 * these tools to actually mutate state.
 */
export const workforceOnlyTools = [promoteToL1];

/**
 * Get a formatted list of tool names and descriptions for prompt injection.
 * Returns a markdown-formatted list of available tools.
 */
export function getToolDescriptions(): string {
  const toolInfo = [
    { name: "get_data_schema", description: "Get the database schema to understand available columns and data types" },
    { name: "query_companies", description: "Search and filter companies by segment, geography, revenue, EBITDA, and other criteria" },
    { name: "get_company_stats", description: "Get aggregate statistics and breakdowns by segment or geography" },
    { name: "get_company_details", description: "Get detailed information about a specific company by name" },
    { name: "web_search", description: "Search the web for company data, financials, market info, and external benchmarks" },
    { name: "query_past_acquisitions", description: "Query historical M&A deals by sector, country, status, or year" },
    { name: "compare_with_past_acquisitions", description: "Compare a company against historical acquisition metrics" },
    { name: "get_past_acquisition_details", description: "Get detailed information about a specific past acquisition" },
    { name: "query_files", description: "Search and retrieve files related to companies, tags, or topics" },
    { name: "propose_workforce_handoff", description: "Offer to send a write-heavy request (including L0→L1 promotions) to the AI Workforce via a confirmation card" },
  ];

  return toolInfo.map((t, i) => `${i + 1}. **${t.name}** - ${t.description}`).join("\n");
}
