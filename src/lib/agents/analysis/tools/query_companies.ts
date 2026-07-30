import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import {
  CompanyFinancialRepository,
  CompanyRepository,
  type CompanyAgentFilters,
} from "@/lib/repositories";

/**
 * Query companies with filters.
 *
 * Returns a compact markdown table of matching companies plus their latest
 * financials. All filters are optional and AND-combined, so the agent can
 * narrow the pipeline along any of the dimensions below in a single call.
 */


/**
 * Query companies with filters.
 *
 * Returns a compact markdown table of matching companies plus their latest
 * financials. All filters are optional and AND-combined, so the agent can
 * narrow the pipeline along any of the dimensions below in a single call.
 */
export const queryCompanies = tool(
  async ({
    segment,
    geography,
    watchlist_status,
    stage,
    include_pre_pipeline,
    name,
    ownership,
    company_focus,
    source,
    status,
    deal_type,
    deal_sponsor,
    deal_captain,
    entered_by,
    banker,
    has_ai_opinion,
    ai_opinion_verdict,
    min_revenue,
    max_revenue,
    min_ebitda,
    max_ebitda,
    created_after,
    created_before,
    search_term,
    limit = 20,
  }: {
    segment?: string;
    geography?: string;
    watchlist_status?: string;
    stage?: string;
    include_pre_pipeline?: boolean;
    name?: string;
    ownership?: string;
    company_focus?: string;
    source?: "inbound" | "outbound";
    status?: "active" | "dropped";
    deal_type?: "majority" | "minority";
    deal_sponsor?: string;
    deal_captain?: string;
    entered_by?: string;
    banker?: string;
    has_ai_opinion?: boolean;
    ai_opinion_verdict?: "pass" | "fail" | "tentative";
    min_revenue?: number;
    max_revenue?: number;
    min_ebitda?: number;
    max_ebitda?: number;
    created_after?: string;
    created_before?: string;
    search_term?: string;
    limit?: number;
  }) => {
    logger.debug(
      `🔧 TOOL CALLED: query_companies(segment='${segment}', stage='${stage}', include_pre_pipeline='${include_pre_pipeline}', name='${name}', search='${search_term}')`,
    );

    try {
      const companyRepo = new CompanyRepository(
        createDb(),
        await getActiveWorkspaceId(),
      );
      const filters: CompanyAgentFilters = {
        segment,
        geography,
        watchlistStatus: watchlist_status,
        stage,
        name,
        ownership,
        companyFocus: company_focus,
        source,
        status,
        dealType: deal_type,
        dealSponsor: deal_sponsor,
        dealCaptain: deal_captain,
        enteredBy: entered_by,
        banker,
        hasAiOpinion: has_ai_opinion,
        aiOpinionVerdict: ai_opinion_verdict,
        minRevenue: min_revenue,
        maxRevenue: max_revenue,
        minEbitda: min_ebitda,
        maxEbitda: max_ebitda,
        createdAfter: created_after,
        createdBefore: created_before,
        searchTerm: search_term,
        limit,
      };

      // Unless the caller explicitly scopes a stage, default the cohort to the
      // L0–L5 committed origination funnel. Earlier triage buckets
      // (market_screening, unreviewed, discovered) are excluded from the default listing so
      // results reflect real deals, not raw intake.
      if (!stage) {
        if (include_pre_pipeline) {
          filters.stageIn = ["market_screening", "unreviewed", "discovered", "L0", "L1", "L2", "L3", "L4", "L5"];
        } else {
          filters.stageIn = ["L0", "L1", "L2", "L3", "L4", "L5"];
        }
      }

      const companies = await companyRepo.searchForAgent(filters);

      if (!companies || companies.length === 0) {
        return "No companies found matching your criteria.";
      }

      const financialRepo = new CompanyFinancialRepository(
        createDb(),
        await getActiveWorkspaceId(),
      );
      const latestFin = await financialRepo.findLatestByCompanies(
        companies.map((c) => c.id),
      );
      const finByCompany = new Map<string, (typeof latestFin)[number]>();
      for (const r of latestFin) finByCompany.set(r.company_id, r);

      const header =
        "Target | Project | Segment | Geography | Stage | Status | AI Opinion | Rev ($M) | EBITDA ($M) | EV ($M)";
      const separator =
        "--- | --- | --- | --- | --- | --- | --- | --- | --- | ---";

      const rows = companies.map((c) => {
        const f = finByCompany.get(c.id);
        const rev =
          f?.revenue_usd_mn != null ? `$${f.revenue_usd_mn.toFixed(1)}` : "-";
        const ebitda =
          f?.ebitda_usd_mn != null ? `$${f.ebitda_usd_mn.toFixed(1)}` : "-";
        const ev = f?.ev_usd_mn != null ? `$${f.ev_usd_mn.toFixed(1)}` : "-";
        const opinion = c.ai_opinion_verdict
          ? c.ai_opinion_verdict.toUpperCase()
          : "-";
        return `${c.target || "N/A"} | ${c.project_name || "-"} | ${c.segment || "-"} | ${c.geography || "-"} | ${c.pipeline_stage || "-"} | ${c.status || "-"} | ${opinion} | ${rev} | ${ebitda} | ${ev}`;
      });

      let result = `**Query Results (${companies.length} companies):**\n\n`;
      result += `| ${header} |\n| ${separator} |\n`;
      result += rows.map((row) => `| ${row} |`).join("\n");

      logger.debug(`✓ Query returned ${companies.length} companies`);
      return result;
    } catch (error) {
      logger.error(`Query error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "query_companies",
    description: `Query/list companies (deal targets) from the pipeline database with optional filters.

Use this to find specific companies by attribute, or to pull a cohort to inspect row-by-row. All filters are optional and AND-combined. For counts/averages/breakdowns across a cohort, prefer get_company_stats — it summarizes without returning every row.

Available filters (every one maps to a real column):
    segment: Segment (partial match, e.g. "Technology", "Semiconductors")
    geography: Geography (partial match, e.g. "USA", "Japan", "APAC")
    watchlist_status: Watchlist status (partial match)
    stage: Pipeline stage (exact, one of: "market_screening", "unreviewed", "discovered", "L0", "L1", "L2", "L3", "L4", "L5"). If omitted, results default to the L0–L5 committed funnel only. Pass an explicit stage to override and scope to any single stage.
    include_pre_pipeline: If true, and no specific stage is provided, the query will search ALL stages (both active L0-L5 and pre-pipeline intake stages). Defaults to false (active L0-L5 only).
    name: Company name (partial, case-insensitive against target OR project_name)
    ownership: Ownership (partial match, e.g. "family office", "PE", "public")
    company_focus: Company focus / what they do (partial match)
    source: Deal origin (exact, one of: "inbound", "outbound")
    status: Record status (exact, one of: "active", "dropped"). Omit for all.
    deal_type: Deal type (exact, one of: "majority", "minority")
    deal_sponsor: Deal sponsor / owner name (partial match, shown at L0–L2)
    deal_captain: Deal captain name (partial match, shown at L3+)
    entered_by: Name of the user who sourced/entered the company (partial match)
    banker: Banker / deal contact (partial match)
    has_ai_opinion: true → only companies that already have an AI Opinion verdict; false → only those without one
    ai_opinion_verdict: AI Opinion verdict (exact, one of: "pass", "fail", "tentative")
    min_revenue / max_revenue: FY2024 revenue bounds (USD millions)
    min_ebitda / max_ebitda: FY2024 EBITDA bounds (USD millions)
    created_after / created_before: Filter by when the company was added to the pipeline (companies.created_at). Inclusive bounds. Accept a date ("2026-01-01") or full ISO-8601 timestamp; combine both for a range.
    search_term: Free-text search across target name, project name, segment, and geography (works for non-English names, e.g. Mandarin — matches whichever of target/project_name holds the string)
    limit: Max rows to return (default: 20, max: 50)

Returns:
    A markdown table: target, project, segment, geography, stage, status, AI opinion, and latest revenue/EBITDA/EV.`,
    schema: z.object({
      segment: z.string().optional().describe("Filter by segment (partial)"),
      geography: z
        .string()
        .optional()
        .describe("Filter by geography (partial)"),
      watchlist_status: z
        .string()
        .optional()
        .describe("Filter by watchlist status (partial)"),
      stage: z
        .enum([
          "market_screening",
          "unreviewed",
          "discovered",
          "L0",
          "L1",
          "L2",
          "L3",
          "L4",
          "L5",
        ])
        .optional()
        .describe("Filter by pipeline stage (exact match)"),
      include_pre_pipeline: z
        .boolean()
        .optional()
        .describe(
          "If true and stage is omitted, searches all stages instead of defaulting to L0-L5",
        ),
      name: z
        .string()
        .optional()
        .describe(
          "Filter by company name (partial, matches target or project_name)",
        ),
      ownership: z
        .string()
        .optional()
        .describe("Filter by ownership (partial match)"),
      company_focus: z
        .string()
        .optional()
        .describe("Filter by company focus (partial match)"),
      source: z
        .enum(["inbound", "outbound"])
        .optional()
        .describe("Filter by deal origin (exact match)"),
      status: z
        .enum(["active", "dropped"])
        .optional()
        .describe("Filter by record status (exact match)"),
      deal_type: z
        .enum(["majority", "minority"])
        .optional()
        .describe("Filter by deal type (exact match)"),
      deal_sponsor: z
        .string()
        .optional()
        .describe("Filter by deal sponsor / owner name (partial match, shown at L0–L2)"),
      deal_captain: z
        .string()
        .optional()
        .describe("Filter by deal captain name (partial match, shown at L3+)"),
      entered_by: z
        .string()
        .optional()
        .describe("Filter by the name of the user who sourced/entered the company (partial match)"),
      banker: z
        .string()
        .optional()
        .describe("Filter by banker / deal contact (partial match)"),
      has_ai_opinion: z
        .boolean()
        .optional()
        .describe(
          "true → only companies with an AI Opinion verdict; false → only those without",
        ),
      ai_opinion_verdict: z
        .enum(["pass", "fail", "tentative"])
        .optional()
        .describe("Filter by AI Opinion verdict (exact match)"),
      min_revenue: z
        .number()
        .optional()
        .describe("Minimum FY2024 revenue (USD M)"),
      max_revenue: z
        .number()
        .optional()
        .describe("Maximum FY2024 revenue (USD M)"),
      min_ebitda: z
        .number()
        .optional()
        .describe("Minimum FY2024 EBITDA (USD M)"),
      max_ebitda: z
        .number()
        .optional()
        .describe("Maximum FY2024 EBITDA (USD M)"),
      created_after: z
        .string()
        .optional()
        .describe(
          "Only companies added on/after this date (inclusive). Date or ISO-8601 timestamp, matched against companies.created_at",
        ),
      created_before: z
        .string()
        .optional()
        .describe(
          "Only companies added on/before this date (inclusive). Date or ISO-8601 timestamp, matched against companies.created_at",
        ),
      search_term: z
        .string()
        .optional()
        .describe(
          "Free-text search across target name, project name, segment, and geography (works for non-English names, e.g. Mandarin — matches whichever of target/project_name holds the string)",
        ),
      limit: z.number().optional().default(20).describe("Max results to return"),
    }),
  },
);
