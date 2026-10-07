import { tool } from "@langchain/core/tools";
import { loadStageLabeler } from "./stageLabels";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import {
  CompanyFinancialRepository,
  CompanyRepository,
} from "@/lib/repositories";
import { buildCompanyMentionsMarker } from "@/lib/navigation/companyMentions";
import {
  COMPANY_FILTER_DOC,
  COMPANY_STAGE_DEFAULT_DOC,
  applyStageDefault,
  companyFilterShape,
  mapCompanyFilters,
  mergeGraphFilter,
  resolveCompanyGraphFilter,
  type CompanyFilterArgs,
} from "./companyFilters";

/**
 * Query companies with filters.
 *
 * The entry point for every company cohort the agent works with. It accepts the
 * full shared filter vocabulary (`companyFilterShape` — one filter per
 * user-meaningful `companies` column, plus relationship-graph filters) and
 * prints each row's uuid, so the follow-on artifact tools (`send_email`'s
 * `company_excel` / `company_card`) can export exactly the rows the user just
 * saw by passing those ids back.
 */

/**
 * How much of a company's free-form Context the table shows per row. The column
 * is a scannable preview, not the full document — `get_company_details` prints
 * it in full for a single company.
 */
const CONTEXT_PREVIEW_CHARS = 300;

/** One-line, pipe-safe preview of a company's Context for the results table. */
function contextPreview(context: string | null | undefined): string {
  const text = context?.replace(/\s+/g, " ").trim();
  if (!text) return "-";
  const clipped =
    text.length > CONTEXT_PREVIEW_CHARS
      ? `${text.slice(0, CONTEXT_PREVIEW_CHARS)}…`
      : text;
  // A literal pipe would split the markdown cell and shift every later column.
  return clipped.replace(/\|/g, "\\|");
}

const argsSchema = z.object({
  ...companyFilterShape,
  include_relationships: z
    .boolean()
    .optional()
    .describe(
      "Append a Relationships column listing each company's direct graph edges. Costs one extra graph read.",
    ),
  include_context: z
    .boolean()
    .optional()
    .describe(
      `Append a Context column previewing each company's free-form markdown Context (first ${CONTEXT_PREVIEW_CHARS} characters). Free — no extra query.`,
    ),
  limit: z.number().optional().default(20).describe("Max results to return"),
});

type Args = z.infer<typeof argsSchema>;

export const queryCompanies = tool(
  async (args: Args) => {
    const { include_relationships, include_context, limit = 20, ...filterArgs } = args;
    logger.debug(
      `🔧 TOOL CALLED: query_companies(segment='${filterArgs.segment}', stage='${filterArgs.stage}', connected_to='${filterArgs.connected_to}', ids=${filterArgs.company_ids?.length ?? 0}, search='${filterArgs.search_term}')`,
    );

    try {
      const db = createDb();
      const workspaceId = await getActiveWorkspaceId();
      const companyRepo = new CompanyRepository(db, workspaceId);

      // Relationship-graph filters live in Neo4j; resolve them into an id
      // include/exclude list first so Postgres can AND them with the columns.
      const graph = await resolveCompanyGraphFilter(
        filterArgs as CompanyFilterArgs,
        () => buildGraphDeps(db, workspaceId, companyRepo),
      );
      if (graph.error) return `**Error:** ${graph.error}`;

      const filters = mergeGraphFilter(
        applyStageDefault(
          mapCompanyFilters(filterArgs as CompanyFilterArgs),
          filterArgs,
        ),
        graph,
      );
      filters.limit = limit;

      const companies = await companyRepo.searchForAgent(filters);

      if (!companies || companies.length === 0) {
        const graphNote = graph.notes.length ? ` ${graph.notes.join(" ")}` : "";
        return `No companies found matching your criteria.${graphNote}`;
      }

      const financialRepo = new CompanyFinancialRepository(db, workspaceId);
      const latestFin = await financialRepo.findLatestByCompanies(
        companies.map((c) => c.id),
      );
      const finByCompany = new Map<string, (typeof latestFin)[number]>();
      for (const r of latestFin) finByCompany.set(r.company_id, r);

      // Relationship column: one graph read for the whole page, never one per
      // row. Reuse the edges the connected_to filter already fetched when it ran.
      const relationshipsById = include_relationships
        ? await loadRelationships(
            db,
            workspaceId,
            companies.map((c) => c.id),
            graph.edgeSummaries,
          )
        : null;

      const stageText = await loadStageLabeler(db, workspaceId);
      const headerCells = [
        "ID",
        "Target",
        "Project",
        "Segment",
        "Geography",
        "Stage",
        "Status",
        "AI Opinion",
        "Rev ($M)",
        "EBITDA ($M)",
        "EV ($M)",
      ];
      if (relationshipsById) headerCells.push("Relationships");
      if (include_context) headerCells.push("Context");

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
        const cells = [
          c.id,
          c.target || "N/A",
          c.project_name || "-",
          c.segment || "-",
          c.geography || "-",
          stageText(c.pipeline_stage) || "-",
          c.status || "-",
          opinion,
          rev,
          ebitda,
          ev,
        ];
        if (relationshipsById) {
          const edges = relationshipsById.get(c.id) ?? [];
          cells.push(edges.length ? edges.join("; ") : "-");
        }
        if (include_context) cells.push(contextPreview(c.context));
        return cells.join(" | ");
      });

      let result = `**Query Results (${companies.length} companies):**\n\n`;
      if (graph.notes.length) result += `${graph.notes.join(" ")}\n\n`;
      result += `| ${headerCells.join(" | ")} |\n`;
      result += `| ${headerCells.map(() => "---").join(" | ")} |\n`;
      result += rows.map((row) => `| ${row} |`).join("\n");
      result +=
        "\n\n_The ID column holds each company's uuid. Pass those ids as `company_ids` to send_email's `company_excel` / `company_card` to export exactly these rows._";
      // The table carries names but no ids in a form the chat UI understands, so
      // append a hidden id↔name manifest; the client chips only the ones the
      // model actually names in its answer.
      const mentionsMarker = buildCompanyMentionsMarker(
        companies.flatMap((c) =>
          [c.target, c.project_name]
            .filter((name): name is string => !!name?.trim())
            .map((name) => ({ id: c.id, name })),
        ),
      );
      if (mentionsMarker) result += `\n\n${mentionsMarker}`;

      logger.debug(`✓ Query returned ${companies.length} companies`);
      return result;
    } catch (error) {
      logger.error(`Query error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "query_companies",
    description: `Query/list companies (deal targets) from the pipeline database.

Use this to find companies by any attribute, or to pull a cohort to inspect row-by-row. For counts/averages/breakdowns across a cohort, prefer get_company_stats — it summarizes without returning every row.

This is also the FIRST STEP of any export: the result table's ID column holds each company's uuid. To email a spreadsheet or a Company Card deck, run query_companies first, then pass those ids as \`company_ids\` to send_email's \`company_excel\` / \`company_card\` — that guarantees the attachment covers exactly the rows you just showed the user.

${COMPANY_FILTER_DOC}

${COMPANY_STAGE_DEFAULT_DOC}

Extra args:
    include_relationships: If true, append a Relationships column listing each company's direct graph edges (who it sells to / invested in / partners with).
    include_context: If true, append a Context column previewing each company's free-form markdown Context — the background a human wrote on the company card's Context tab. Set this whenever the question turns on qualitative background (why a deal matters, what was said about it, how it was sourced) rather than on columns alone; the preview is truncated, so call get_company_details for the full text once you know which company you care about.
    limit: Max rows to return (default: 20, max: 50)

Returns:
    A markdown table: company id, target, project, segment, geography, stage, status, AI opinion, and latest revenue/EBITDA/EV (plus relationships / context when requested).`,
    schema: argsSchema,
  },
);

/**
 * Wire the graph resolver's dependencies. Imported lazily so a plain
 * column-filter query never pays for the Neo4j driver, and so the service
 * container (which transitively reaches this tool registry) isn't pulled in at
 * module-evaluation time.
 */
async function buildGraphDeps(
  db: ReturnType<typeof createDb>,
  workspaceId: string,
  companyRepo: CompanyRepository,
) {
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
 * Direct edges for the companies on this page, as one-line summaries. Uses a
 * single whole-graph read (not one lookup per row) and reuses whatever the
 * connected_to filter already resolved.
 */
async function loadRelationships(
  db: ReturnType<typeof createDb>,
  workspaceId: string,
  ids: string[],
  alreadyResolved: Map<string, string[]>,
): Promise<Map<string, string[]>> {
  if (alreadyResolved.size > 0) return alreadyResolved;
  const { createContainer } = await import("@/lib/services/container");
  const { companyGraphService } = createContainer(db, workspaceId);
  const graph = await companyGraphService.getGraphData();
  const nameById = new Map(graph.nodes.map((n) => [n.id, n.name]));
  const wanted = new Set(ids);
  const byCompany = new Map<string, string[]>();
  for (const link of graph.links) {
    const label = `${nameById.get(link.source) ?? link.source} --${link.label}--> ${
      nameById.get(link.target) ?? link.target
    }`;
    for (const endpoint of [link.source, link.target]) {
      if (!wanted.has(endpoint)) continue;
      const list = byCompany.get(endpoint) ?? [];
      list.push(label);
      byCompany.set(endpoint, list);
    }
  }
  return byCompany;
}
