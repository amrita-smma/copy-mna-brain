import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from '@/lib/workspace';
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import {
  CompanyFinancialRepository,
  CompanyRepository,
  type CompanyAgentFilters,
  type Tables,
} from "@/lib/repositories";

type Company = Tables<"companies">;

/** Dimensions the cohort can be broken down by. */
const GROUP_BY_DIMENSIONS = [
  "segment",
  "geography",
  "stage",
  "source",
  "status",
  "ownership",
  "deal_type",
  "ai_opinion",
] as const;
type GroupByDimension = (typeof GROUP_BY_DIMENSIONS)[number];

/** Pull the bucket key for a company along a given dimension. */
function dimensionKey(c: Company, dim: GroupByDimension): string {
  switch (dim) {
    case "segment":
      return c.segment || "Unknown";
    case "geography":
      return c.geography || "Unknown";
    case "stage":
      return c.pipeline_stage || "Unknown";
    case "source":
      return c.source || "Unknown";
    case "status":
      return c.status || "Unknown";
    case "ownership":
      return c.ownership || "Unknown";
    case "deal_type":
      return c.deal_type || "Unknown";
    case "ai_opinion":
      return c.ai_opinion_verdict
        ? c.ai_opinion_verdict.toUpperCase()
        : "No opinion";
  }
}

function avg(nums: number[]): number {
  return nums.length > 0 ? nums.reduce((s, v) => s + v, 0) / nums.length : 0;
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Render a "| Key | Count | % | Avg Rev | Avg EBITDA |" breakdown table. */
function renderBreakdown(
  title: string,
  keyHeader: string,
  companies: Company[],
  total: number,
  revBy: Map<string, number>,
  ebitdaBy: Map<string, number>,
  keyOf: (c: Company) => string,
): string {
  const buckets = new Map<string, Company[]>();
  for (const c of companies) {
    const key = keyOf(c);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(c);
  }

  let out = `\n**${title}:**\n\n`;
  out += `| ${keyHeader} | Count | % | Avg Rev ($M) | Avg EBITDA ($M) |\n`;
  out += `| --- | --- | --- | --- | --- |\n`;
  Array.from(buckets.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 20)
    .forEach(([key, items]) => {
      const revVals = items
        .map((i) => revBy.get(i.id))
        .filter((v): v is number => v != null);
      const ebVals = items
        .map((i) => ebitdaBy.get(i.id))
        .filter((v): v is number => v != null);
      const pct = total > 0 ? ((items.length / total) * 100).toFixed(0) : "0";
      out += `| ${key} | ${items.length} | ${pct}% | ${avg(revVals).toFixed(1)} | ${avg(ebVals).toFixed(1)} |\n`;
    });
  return out;
}

/**
 * Get aggregate statistics for a (optionally filtered) cohort of companies.
 *
 * This is the "summarize the pipeline" tool: it answers count / coverage /
 * average / breakdown questions in ONE call instead of paging through
 * query_companies. It accepts the same filters as query_companies so the
 * agent can scope the summary (e.g. "stats for inbound semiconductor deals
 * that already have an AI Opinion") and exposes AI-Opinion coverage and other
 * pipeline utility out of the box.
 */
export const getCompanyStats = tool(
  async ({
    group_by,
    segment,
    geography,
    watchlist_status,
    stage,
    name,
    ownership,
    company_focus,
    source,
    status,
    deal_type,
    deal_sponsor,
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
  }: {
    group_by?: GroupByDimension[];
    segment?: string;
    geography?: string;
    watchlist_status?: string;
    stage?: string;
    name?: string;
    ownership?: string;
    company_focus?: string;
    source?: "inbound" | "outbound";
    status?: "active" | "dropped";
    deal_type?: "majority" | "minority";
    deal_sponsor?: string;
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
  }) => {
    const groupBy =
      group_by && group_by.length > 0 ? group_by : (["segment"] as const);
    logger.debug(
      `🔧 TOOL CALLED: get_company_stats(group_by='${groupBy.join(",")}', filters applied)`
    );

    try {
      const db = createDb();
      const companyRepo = new CompanyRepository(db, await getActiveWorkspaceId());
      const financialRepo = new CompanyFinancialRepository(db, await getActiveWorkspaceId());

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
      };
      const hasFilter = Object.values(filters).some((v) => v !== undefined);

      const companies = await companyRepo.findForAgentStats(filters);
      if (!companies || companies.length === 0) {
        return hasFilter
          ? "No companies match the given filters."
          : "No companies in the database.";
      }

      const latestFin = await financialRepo.findLatestByCompanies(
        companies.map((c) => c.id),
      );
      const revBy = new Map<string, number>();
      const ebitdaBy = new Map<string, number>();
      for (const r of latestFin) {
        if (r.revenue_usd_mn != null) revBy.set(r.company_id, r.revenue_usd_mn);
        if (r.ebitda_usd_mn != null)
          ebitdaBy.set(r.company_id, r.ebitda_usd_mn);
      }

      const total = companies.length;
      const revVals = Array.from(revBy.values());
      const ebVals = Array.from(ebitdaBy.values());

      // AI Opinion coverage.
      const withOpinion = companies.filter((c) => c.ai_opinion_verdict);
      const verdictCounts = { pass: 0, fail: 0, tentative: 0, other: 0 };
      for (const c of withOpinion) {
        const v = (c.ai_opinion_verdict || "").toLowerCase();
        if (v === "pass") verdictCounts.pass++;
        else if (v === "fail") verdictCounts.fail++;
        else if (v === "tentative") verdictCounts.tentative++;
        else verdictCounts.other++;
      }
      const processing = companies.filter(
        (c) => c.ai_opinion_status === "processing",
      ).length;

      const activeCount = companies.filter((c) => c.status === "active").length;
      const droppedCount = companies.filter(
        (c) => c.status === "dropped",
      ).length;
      const inboundCount = companies.filter(
        (c) => c.source === "inbound",
      ).length;
      const outboundCount = companies.filter(
        (c) => c.source === "outbound",
      ).length;

      const scope = hasFilter ? " (filtered cohort)" : "";
      let result = `## Company Statistics${scope}\n\n`;
      result += `**Overview:**\n`;
      result += `- Total companies: ${total}\n`;
      result += `- Status: ${activeCount} active · ${droppedCount} dropped\n`;
      result += `- Source: ${inboundCount} inbound · ${outboundCount} outbound\n`;
      result += `- With revenue data: ${revVals.length} · with EBITDA data: ${ebVals.length}\n`;
      result += `\n**Financials (latest year):**\n`;
      result += `- Total revenue: $${revVals.reduce((s, v) => s + v, 0).toFixed(1)}M · avg $${avg(revVals).toFixed(1)}M · median $${median(revVals).toFixed(1)}M\n`;
      result += `- Total EBITDA: $${ebVals.reduce((s, v) => s + v, 0).toFixed(1)}M · avg $${avg(ebVals).toFixed(1)}M · median $${median(ebVals).toFixed(1)}M\n`;
      result += `\n**AI Opinion coverage:**\n`;
      result += `- With opinion: ${withOpinion.length}/${total} (${total > 0 ? ((withOpinion.length / total) * 100).toFixed(0) : "0"}%) · without: ${total - withOpinion.length}\n`;
      result += `- Verdicts: ${verdictCounts.pass} pass · ${verdictCounts.fail} fail · ${verdictCounts.tentative} tentative`;
      if (verdictCounts.other > 0) result += ` · ${verdictCounts.other} other`;
      result += `\n`;
      if (processing > 0) result += `- In progress: ${processing}\n`;

      // Requested breakdowns.
      const titles: Record<GroupByDimension, [string, string]> = {
        segment: ["By Segment", "Segment"],
        geography: ["By Geography", "Geography"],
        stage: ["By Pipeline Stage", "Stage"],
        source: ["By Source", "Source"],
        status: ["By Status", "Status"],
        ownership: ["By Ownership", "Ownership"],
        deal_type: ["By Deal Type", "Deal Type"],
        ai_opinion: ["By AI Opinion", "Verdict"],
      };
      for (const dim of groupBy) {
        const [title, keyHeader] = titles[dim];
        result += renderBreakdown(
          title,
          keyHeader,
          companies,
          total,
          revBy,
          ebitdaBy,
          (c) => dimensionKey(c, dim),
        );
      }

      logger.debug("✓ Statistics calculated");
      return result;
    } catch (error) {
      logger.error(`Stats error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "get_company_stats",
    description: `Aggregate summary of the company pipeline — counts, coverage, averages, and breakdowns — for a whole cohort in ONE call. Use this instead of paging through query_companies whenever the question is "how many", "what share", "average/median", "breakdown by", or "coverage of".

The summary always reports: total companies, active vs dropped, inbound vs outbound, financial data coverage, revenue/EBITDA totals + averages + medians, and AI Opinion coverage (with/without an opinion and the pass/fail/tentative split).

Scope the cohort with the SAME filters as query_companies (all optional, AND-combined):
    segment, geography, watchlist_status, stage, name, ownership, company_focus,
    source ("inbound"|"outbound"), status ("active"|"dropped"),
    deal_type ("majority"|"minority"), deal_sponsor, banker,
    has_ai_opinion (true → only companies WITH an AI Opinion; false → only those WITHOUT),
    ai_opinion_verdict ("pass"|"fail"|"tentative"),
    min_revenue / max_revenue / min_ebitda / max_ebitda (FY2024, USD M),
    created_after / created_before (companies.created_at bounds, inclusive; date or ISO-8601 timestamp),
    search_term (target name/project name/segment/geography).

Note: "discovered" relationship-graph stubs are always excluded from the snapshot — the aggregate covers the origination pipeline only.

group_by: optional array of breakdown dimensions to append as tables. Any of:
    "segment", "geography", "stage", "source", "status", "ownership", "deal_type", "ai_opinion".
    Defaults to ["segment"]. Pass multiple to get several breakdowns at once, e.g. ["stage", "ai_opinion"].

Examples:
    - Overall pipeline health: call with no args.
    - "How many inbound deals lack an AI opinion?": source="inbound", has_ai_opinion=false.
    - "Pass/fail split of semiconductor targets by stage": segment="semiconductor", group_by=["ai_opinion","stage"].

Returns:
    Markdown: an overview + financials + AI-opinion block, followed by one breakdown table per requested dimension (each with count, % of cohort, avg revenue, avg EBITDA).`,
    schema: z.object({
      group_by: z
        .array(z.enum(GROUP_BY_DIMENSIONS))
        .optional()
        .describe(
          'Breakdown dimensions to append, e.g. ["stage","ai_opinion"]. Defaults to ["segment"].',
        ),
      segment: z.string().optional().describe("Filter by segment (partial)"),
      geography: z.string().optional().describe("Filter by geography (partial)"),
      watchlist_status: z
        .string()
        .optional()
        .describe("Filter by watchlist status (partial)"),
      stage: z
        .enum([
          "market_screening",
          "unreviewed",
          "L0",
          "L1",
          "L2",
          "L3",
          "L4",
          "L5",
          "discovered",
        ])
        .optional()
        .describe("Filter by pipeline stage (exact)"),
      name: z
        .string()
        .optional()
        .describe("Filter by company name (partial, target or project_name)"),
      ownership: z
        .string()
        .optional()
        .describe("Filter by ownership (partial)"),
      company_focus: z
        .string()
        .optional()
        .describe("Filter by company focus (partial)"),
      source: z
        .enum(["inbound", "outbound"])
        .optional()
        .describe("Filter by deal origin (exact)"),
      status: z
        .enum(["active", "dropped"])
        .optional()
        .describe("Filter by record status (exact)"),
      deal_type: z
        .enum(["majority", "minority"])
        .optional()
        .describe("Filter by deal type (exact)"),
      deal_sponsor: z
        .string()
        .optional()
        .describe("Filter by deal sponsor / owner (partial)"),
      banker: z
        .string()
        .optional()
        .describe("Filter by banker / deal contact (partial)"),
      has_ai_opinion: z
        .boolean()
        .optional()
        .describe(
          "true → only companies with an AI Opinion; false → only those without",
        ),
      ai_opinion_verdict: z
        .enum(["pass", "fail", "tentative"])
        .optional()
        .describe("Filter by AI Opinion verdict (exact)"),
      min_revenue: z.number().optional().describe("Minimum FY2024 revenue (USD M)"),
      max_revenue: z.number().optional().describe("Maximum FY2024 revenue (USD M)"),
      min_ebitda: z.number().optional().describe("Minimum FY2024 EBITDA (USD M)"),
      max_ebitda: z.number().optional().describe("Maximum FY2024 EBITDA (USD M)"),
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
          "Free-text search across target name, project name, segment, and geography",
        ),
    }),
  }
);
