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
import { invenPaidDataSourceSearch } from "./inven_paid_data_source_search";
import { invenPaidDataSourceEnrichment } from "./inven_paid_data_source_enrichment";
import { queryMeetingNotes } from "./query_files";

export {
  getDataSchema,
  queryCompanies,
  getCompanyStats,
  getCompanyDetails,
  webSearch,
  queryPastAcquisitions,
  compareWithPastAcquisitions,
  getPastAcquisitionDetails,
  invenPaidDataSourceSearch,
  invenPaidDataSourceEnrichment,
  queryMeetingNotes,
};

export {
  companiesSchema,
  companyFinancialsSchema,
  companyFxAdjustmentsSchema,
  companyScreeningDerivedSchema,
  invenCacheSchema,
} from "./schemas";

export const tools = [
  getDataSchema,
  queryCompanies,
  getCompanyStats,
  getCompanyDetails,
  webSearch,
  queryPastAcquisitions,
  compareWithPastAcquisitions,
  getPastAcquisitionDetails,
  invenPaidDataSourceSearch,
  invenPaidDataSourceEnrichment,
  queryMeetingNotes,
];

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
    { name: "inven_paid_data_source_search", description: "Search for companies using Inven's AI-powered search for Screening and Sourcing" },
    { name: "inven_paid_data_source_enrichment", description: "Get detailed company data from Inven by company IDs and cache results" },
    { name: "query_files", description: "Search and retrieve files related to companies, tags, or topics" },
  ];

  return toolInfo.map((t, i) => `${i + 1}. **${t.name}** - ${t.description}`).join("\n");
}
