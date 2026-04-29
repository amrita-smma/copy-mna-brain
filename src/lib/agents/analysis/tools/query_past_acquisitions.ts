import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { PastAcquisitionRepository } from "@/lib/repositories";

/**
 * Query past acquisitions with filters.
 */
export const queryPastAcquisitions = tool(
  async ({
    sector,
    country,
    status,
    project_type,
    year,
    search_term,
    limit = 20,
  }: {
    sector?: string;
    country?: string;
    status?: string;
    project_type?: string;
    year?: string;
    search_term?: string;
    limit?: number;
  }) => {
    logger.debug(
      `🔧 TOOL CALLED: query_past_acquisitions(sector='${sector}', country='${country}', search='${search_term}')`
    );

    try {
      const pastRepo = new PastAcquisitionRepository(createDb());
      const acquisitions = await pastRepo.searchForAgent({
        sector,
        country,
        status,
        projectType: project_type,
        year,
        searchTerm: search_term,
        limit,
      });

      if (!acquisitions || acquisitions.length === 0) {
        return "No past acquisitions found matching your criteria.";
      }

      const header = "Project Name | Type | Sector | Country | EV ($M) | Revenue ($M) | EBITDA ($M) | Status | Year";
      const separator = "--- | --- | --- | --- | --- | --- | --- | --- | ---";

      const rows = acquisitions.map((a) => {
        const ev = a.ev_100_pct_usd_m || "-";
        const rev = a.revenue_usd_m || "-";
        const ebitda = a.ebitda_usd_m || "-";
        return `${a.project_name || "N/A"} | ${a.project_type || "-"} | ${a.sector || "-"} | ${a.country || "-"} | ${ev} | ${rev} | ${ebitda} | ${a.status || "-"} | ${a.year || "-"}`;
      });

      let result = `**Past Acquisitions (${acquisitions.length} deals):**\n\n`;
      result += `| ${header} |\n| ${separator} |\n`;
      result += rows.map((row) => `| ${row} |`).join("\n");

      logger.debug(`✓ Query returned ${acquisitions.length} past acquisitions`);
      return result;
    } catch (error) {
      logger.error(`Query error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "query_past_acquisitions",
    description: `Query past acquisitions from the database with optional filters.

Use this tool to find historical deals by sector, country, status, or search terms.
All filters are optional and can be combined.

Args:
    sector: Filter by sector (partial match, e.g., "Technology", "Healthcare")
    country: Filter by country (partial match, e.g., "USA", "Japan")
    status: Filter by deal status (e.g., "Closed", "Dropped")
    project_type: Filter by project type
    year: Filter by year
    search_term: Search across project name, target company, and sector
    limit: Maximum number of results (default: 20, max: 50)

Returns:
    A table of matching past acquisitions with key deal metrics.`,
    schema: z.object({
      sector: z.string().optional().describe("Filter by sector"),
      country: z.string().optional().describe("Filter by country"),
      status: z.string().optional().describe("Filter by deal status"),
      project_type: z.string().optional().describe("Filter by project type"),
      year: z.string().optional().describe("Filter by year"),
      search_term: z.string().optional().describe("Search term for name/sector"),
      limit: z.number().optional().default(20).describe("Max results to return"),
    }),
  }
);
