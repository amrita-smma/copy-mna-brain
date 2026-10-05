import { tool } from "@langchain/core/tools";
import { loadStageLabeler } from "./stageLabels";
import { getActiveWorkspaceId } from '@/lib/workspace';
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import {
  CompanyFinancialRepository,
  CompanyRepository,
  type Tables,
} from "@/lib/repositories";
import {
  COMPANY_FILTER_DOC,
  COMPANY_STAGE_DEFAULT_DOC,
  PRE_PIPELINE_STAGE_KEYS,
  companyFilterShape,
  mapCompanyFilters,
  mergeGraphFilter,
  resolveCompanyGraphFilter,
  type CompanyFilterArgs,
  type GraphDeps,
} from "./companyFilters";

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
function dimensionKey(
  c: Company,
  dim: GroupByDimension,
  stageText: (stage: string | null | undefined) => string | null,
): string {
  switch (dim) {
    case "segment":
      return c.segment || "Unknown";
    case "geography":
      return c.geography || "Unknown";
    case "stage":
      return stageText(c.pipeline_stage) || "Unknown";
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

const argsSchema = z.object({
  group_by: z
    .array(z.enum(GROUP_BY_DIMENSIONS))
    .optional()
    .describe(
      'Breakdown dimensions to append, e.g. ["stage","ai_opinion"]. Defaults to ["segment"].',
    ),
  ...companyFilterShape,
});

type StatsArgs = z.infer<typeof argsSchema>;

/**
 * Wire the graph resolver's dependencies. Imported lazily so a plain
 * column-filter cohort never constructs the Neo4j-backed services, and so the
 * service container (which transitively reaches this tool registry) isn't
 * pulled in at module-evaluation time.
 */
async function buildGraphDeps(
  db: ReturnType<typeof createDb>,
  workspaceId: string,
  companyRepo: CompanyRepository,
): Promise<GraphDeps> {
  const { createContainer } = await import("@/lib/services/container");
  const { companyGraphService } = createContainer(db, workspaceId);
  return {
    resolveCompany: async (nameOrId: string) => {
      const match = await companyRepo.findByNameFuzzy(nameOrId);
      return match
        ? { id: match.id, name: match.target || match.project_name || nameOrId }
        : null;
    },
    getConnectedCompanies: (id: string) =>
      companyGraphService.getConnectedCompanies(id),
    getGraphData: () => companyGraphService.getGraphData(),
  };
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
  async (args: StatsArgs) => {
    const { group_by, ...filterArgs } = args;
    const groupBy =
      group_by && group_by.length > 0 ? group_by : (["segment"] as const);
    logger.debug(
      `🔧 TOOL CALLED: get_company_stats(group_by='${groupBy.join(",")}', filters applied)`
    );

    try {
      const db = createDb();
      const workspaceId = await getActiveWorkspaceId();
      const companyRepo = new CompanyRepository(db, workspaceId);
      const financialRepo = new CompanyFinancialRepository(db, workspaceId);
      const stageText = await loadStageLabeler(db, workspaceId);

      // Graph filters live in Neo4j; resolve them into an id include/exclude
      // list before Postgres sees the cohort.
      const graph = await resolveCompanyGraphFilter(filterArgs, () =>
        buildGraphDeps(db, workspaceId, companyRepo),
      );
      if (graph.error) return `**Error:** ${graph.error}`;

      const filters = mergeGraphFilter(
        mapCompanyFilters(filterArgs as CompanyFilterArgs),
        graph,
      );
      const hasFilter = Object.values(filters).some((v) => v !== undefined);

      // Unless the caller explicitly scopes a stage (or pins exact ids), default
      // the cohort to the committed origination funnel (every workspace stage). Earlier triage
      // buckets (market_screening, unreviewed, discovered) are excluded from the
      // default snapshot so pipeline stats reflect real deals, not raw intake.
      if (
        !filterArgs.stage &&
        !(filterArgs.stage_in && filterArgs.stage_in.length > 0) &&
        !filterArgs.company_ids
      ) {
        filters.stageNotIn = filterArgs.include_pre_pipeline ? [] : [...PRE_PIPELINE_STAGE_KEYS];
      }

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
          (c) => dimensionKey(c, dim, stageText),
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

Scope the cohort with the SAME filter vocabulary as query_companies and send_email's company_excel:

${COMPANY_FILTER_DOC}

${COMPANY_STAGE_DEFAULT_DOC}

Note: "discovered" relationship-graph stubs are excluded from the snapshot unless you ask for them (via stage / stage_in / include_pre_pipeline / company_ids) — the aggregate covers the origination pipeline only.

group_by: optional array of breakdown dimensions to append as tables. Any of:
    "segment", "geography", "stage", "source", "status", "ownership", "deal_type", "ai_opinion".
    Defaults to ["segment"]. Pass multiple to get several breakdowns at once, e.g. ["stage", "ai_opinion"].

Examples:
    - Overall pipeline health: call with no args.
    - "How many inbound deals lack an AI opinion?": source="inbound", has_ai_opinion=false.
    - "Pass/fail split of semiconductor targets by stage": segment="semiconductor", group_by=["ai_opinion","stage"].
    - "How many of our L2+ deals are connected to Acme?": stage_in=["L2","L3","L4","L5"], connected_to="Acme".

Returns:
    Markdown: an overview + financials + AI-opinion block, followed by one breakdown table per requested dimension (each with count, % of cohort, avg revenue, avg EBITDA).`,
    schema: argsSchema,
  }
);
