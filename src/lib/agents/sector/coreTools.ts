/**
 * The tools every sector agent gets, per role. Each agent adds its hand-picked
 * extras in `<agent>/tools/index.ts` via `composeSectorTools`.
 *
 * These are the EXISTING tool objects from the analysis agent — sector agents
 * add no tools of their own in Phase 1 (ingestion is out of scope), so the
 * one-tool-per-file rule is satisfied by the files under analysis/tools.
 *
 * Why these:
 *   - Research: web_search / web_fetch (the only way to the public sector
 *     sources) and valyu_search (filings, research; named by the shared
 *     grounding and workforce evidence guides).
 *   - Internal record: get_data_schema, query_companies, get_company_stats,
 *     get_company_details (cohort members and deals already on file — the
 *     company-mentions guide names query_companies / get_company_stats), and
 *     query_files (memos and models: @bangun's phase layer is built from
 *     internal deal history).
 *   - Insights: get_insight and get_insight_template in both roles — a sector
 *     agent's output is an insight (dashboard).
 *   - Chat only: read_page_context / navigate_page (the console guide), the
 *     propose_insight_* and propose_report_plan approval cards (the insight
 *     authoring guide; propose_insight_refresh is the MB-552 refresh offer), and propose_workforce_handoff — chat never writes, so
 *     long deliverables and any pipeline write go through the Workforce.
 *   - Workforce only: narrate_step and report_progress (the trace contract),
 *     ask_owner (MB-561 HITL), and create_insight / edit_insight_section /
 *     replace_insight_document (incremental authoring and MB-558 refreshes).
 *
 * Deliberately absent: every pipeline write (add/promote/drop/update company,
 * AI Opinions, relationship-graph writes), the bulk-action cards, email, CRM
 * and fund-ledger tools. A sector agent answers sector questions and authors
 * insights; pipeline work stays with the general CoPilot and Workforce.
 */
import {
  SERVER_TOOLS,
  askOwner,
  createInsight,
  editInsightSection,
  getCompanyDetails,
  getCompanyStats,
  getDataSchema,
  getInsight,
  getInsightTemplate,
  narrateStep,
  navigatePage,
  proposeInsightCreate,
  proposeInsightEdit,
  proposeInsightRefresh,
  proposeReportPlan,
  proposeWorkforceHandoff,
  queryCompanies,
  queryMeetingNotes,
  readPageContext,
  replaceInsightDocument,
  reportProgress,
  valyuSearch,
} from '@/lib/agents/analysis/tools';
import type { ToolList } from '@/lib/agents/analysis';
import type { SectorAgentRole } from './types';

/** Read tools shared by both roles. */
const SECTOR_READ_CORE_TOOLS: ToolList = [
  ...SERVER_TOOLS,
  valyuSearch,
  getDataSchema,
  queryCompanies,
  getCompanyStats,
  getCompanyDetails,
  queryMeetingNotes,
  getInsight,
  getInsightTemplate,
];

export const SECTOR_CHAT_CORE_TOOLS: ToolList = [
  ...SECTOR_READ_CORE_TOOLS,
  readPageContext,
  navigatePage,
  proposeInsightCreate,
  proposeInsightEdit,
  proposeInsightRefresh,
  proposeReportPlan,
  proposeWorkforceHandoff,
];

export const SECTOR_WORKFORCE_CORE_TOOLS: ToolList = [
  ...SECTOR_READ_CORE_TOOLS,
  narrateStep,
  reportProgress,
  askOwner,
  createInsight,
  editInsightSection,
  replaceInsightDocument,
];

export type SectorToolSet = Record<SectorAgentRole, ToolList>;

/**
 * Core + the agent's extras, per role. Extras must be read-only tools safe in
 * both roles (they are appended to each). A tool already in a core list is
 * skipped so no name is registered twice with createAgent.
 */
export function composeSectorTools(extras: ToolList): SectorToolSet {
  const withExtras = (core: ToolList): ToolList => {
    const names = new Set(core.map((t) => t.name));
    return [...core, ...extras.filter((t) => !names.has(t.name))];
  };
  return {
    chat: withExtras(SECTOR_CHAT_CORE_TOOLS),
    workforce: withExtras(SECTOR_WORKFORCE_CORE_TOOLS),
  };
}
