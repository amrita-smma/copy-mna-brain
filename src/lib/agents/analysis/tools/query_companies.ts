import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { CompanyFinancialRepository, CompanyRepository } from "@/lib/repositories";

/**
 * Query companies with filters.
 */
export const queryCompanies = tool(
  async ({
    segment,
    geography,
    watchlist_status,
    stage,
    name,
    ownership,
    company_focus,
    source,
    status,
    min_revenue,
    max_revenue,
    min_ebitda,
    max_ebitda,
    search_term,
    limit = 20,
  }: {
    segment?: string;
    geography?: string;
    watchlist_status?: string;
    stage?: string;
    name?: string;
    ownership?: string;
    company_focus?: string;
    source?: "inbound" | "outbound";
    status?: "active" | "dropped";
    min_revenue?: number;
    max_revenue?: number;
    min_ebitda?: number;
    max_ebitda?: number;
    search_term?: string;
    limit?: number;
  }) => {
    logger.debug(
      `🔧 TOOL CALLED: query_companies(segment='${segment}', geography='${geography}', stage='${stage}', name='${name}', ownership='${ownership}', source='${source}', status='${status}', search='${search_term}')`
    );

    try {
      const companyRepo = new CompanyRepository(createDb());
      const companies = await companyRepo.searchForAgent({
        segment,
        geography,
        watchlistStatus: watchlist_status,
        stage,
        name,
        ownership,
        companyFocus: company_focus,
        source,
        status,
        minRevenue: min_revenue,
        maxRevenue: max_revenue,
        minEbitda: min_ebitda,
        maxEbitda: max_ebitda,
        searchTerm: search_term,
        limit,
      });

      if (!companies || companies.length === 0) {
        return "No companies found matching your criteria.";
      }

      const financialRepo = new CompanyFinancialRepository(createDb());
      const latestFin = await financialRepo.findLatestByCompanies(
        companies.map((c) => c.id),
      );
      const finByCompany = new Map<string, typeof latestFin[number]>();
      for (const r of latestFin) finByCompany.set(r.company_id, r);

      const header = "Target | Project | Segment | Geography | Status | Rev ($M) | EBITDA ($M) | EV ($M)";
      const separator = "--- | --- | --- | --- | --- | --- | --- | ---";

      const rows = companies.map((c) => {
        const f = finByCompany.get(c.id);
        const rev = f?.revenue_usd_mn != null ? `$${f.revenue_usd_mn.toFixed(1)}` : "-";
        const ebitda = f?.ebitda_usd_mn != null ? `$${f.ebitda_usd_mn.toFixed(1)}` : "-";
        const ev = f?.ev_usd_mn != null ? `$${f.ev_usd_mn.toFixed(1)}` : "-";
        return `${c.target || "N/A"} | ${c.project_name || "-"} | ${c.segment || "-"} | ${c.geography || "-"} | ${c.watchlist_status || "-"} | ${rev} | ${ebitda} | ${ev}`;
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
    description: `Query companies or projects from the database with optional filters.

Use this tool to find companies or projects by segment, geography, financial metrics, or search terms.
All filters are optional and can be combined.

Args:
    segment: Filter by segment (partial match, e.g., "Technology", "Healthcare")
    geography: Filter by geography (partial match, e.g., "USA", "Japan", "Europe")
    watchlist_status: Filter by status (e.g., "Active", "Inactive")
    stage: Filter by pipeline stage (exact match, one of: "market_screening", "L0", "L1", "L2", "L3", "L4", "L5")
    name: Filter by company name (partial, case-insensitive match against target or project_name)
    ownership: Filter by ownership (partial match, e.g., "family office", "PE", "public")
    company_focus: Filter by company focus (partial match)
    source: Filter by deal origin (exact match, one of: "inbound", "outbound")
    status: Filter by record status (exact match, one of: "active", "dropped"). Defaults to all if omitted.
    min_revenue: Minimum 2024 revenue in USD millions
    max_revenue: Maximum 2024 revenue in USD millions
    min_ebitda: Minimum 2024 EBITDA in USD millions
    max_ebitda: Maximum 2024 EBITDA in USD millions
    search_term: Search across target name, segment, and company focus
    limit: Maximum number of results (default: 20, max: 50)

Returns:
    A table of matching companies with key financial metrics.`,
    schema: z.object({
      segment: z.string().optional().describe("Filter by segment"),
      geography: z.string().optional().describe("Filter by geography"),
      watchlist_status: z.string().optional().describe("Filter by watchlist status"),
      stage: z
        .enum(["market_screening", "L0", "L1", "L2", "L3", "L4", "L5"])
        .optional()
        .describe("Filter by pipeline stage (exact match)"),
      name: z
        .string()
        .optional()
        .describe("Filter by company name (partial, matches target or project_name)"),
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
      min_revenue: z.number().optional().describe("Minimum 2024 revenue (USD M)"),
      max_revenue: z.number().optional().describe("Maximum 2024 revenue (USD M)"),
      min_ebitda: z.number().optional().describe("Minimum 2024 EBITDA (USD M)"),
      max_ebitda: z.number().optional().describe("Maximum 2024 EBITDA (USD M)"),
      search_term: z.string().optional().describe("Search term for name/segment"),
      limit: z.number().optional().default(20).describe("Max results to return"),
    }),
  }
);
