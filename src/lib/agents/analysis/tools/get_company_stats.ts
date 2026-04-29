import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { CompanyFinancialRepository, CompanyRepository } from "@/lib/repositories";

/**
 * Get aggregate statistics for companies.
 */
export const getCompanyStats = tool(
  async ({ group_by }: { group_by?: string }) => {
    logger.debug(`🔧 TOOL CALLED: get_company_stats(group_by='${group_by}')`);

    try {
      const db = createDb();
      const companyRepo = new CompanyRepository(db);
      const financialRepo = new CompanyFinancialRepository(db);
      const companies = await companyRepo.findAll();
      if (!companies || companies.length === 0) {
        return "No companies in the database.";
      }

      const latestFin = await financialRepo.findLatestByCompanies(
        companies.map((c) => c.id),
      );
      const revLatest = new Map<string, number>();
      const ebitdaLatest = new Map<string, number>();
      for (const r of latestFin) {
        if (r.revenue_usd_mn != null) revLatest.set(r.company_id, r.revenue_usd_mn);
        if (r.ebitda_usd_mn != null) ebitdaLatest.set(r.company_id, r.ebitda_usd_mn);
      }

      const totalCompanies = companies.length;
      const withRevenue = companies.filter((c) => revLatest.has(c.id));
      const withEbitda = companies.filter((c) => ebitdaLatest.has(c.id));

      const totalRevenue = withRevenue.reduce((sum, c) => sum + (revLatest.get(c.id) || 0), 0);
      const avgRevenue = withRevenue.length > 0 ? totalRevenue / withRevenue.length : 0;

      const totalEbitda = withEbitda.reduce((sum, c) => sum + (ebitdaLatest.get(c.id) || 0), 0);
      const avgEbitda = withEbitda.length > 0 ? totalEbitda / withEbitda.length : 0;

      let result = `## Company Statistics

**Overall Summary:**
- Total Companies: ${totalCompanies}
- Companies with Revenue Data: ${withRevenue.length}
- Companies with EBITDA Data: ${withEbitda.length}
- Total Revenue (latest year): $${totalRevenue.toFixed(1)}M
- Average Revenue (latest year): $${avgRevenue.toFixed(1)}M
- Total EBITDA (latest year): $${totalEbitda.toFixed(1)}M
- Average EBITDA (latest year): $${avgEbitda.toFixed(1)}M

`;

      if (group_by === "segment" || !group_by) {
        const bySegment = new Map<string, typeof companies>();
        companies.forEach((c) => {
          const key = c.segment || "Unknown";
          if (!bySegment.has(key)) bySegment.set(key, []);
          bySegment.get(key)!.push(c);
        });

        result += `**By Segment:**\n\n`;
        result += `| Segment | Count | Avg Rev ($M) | Avg EBITDA ($M) |\n`;
        result += `| --- | --- | --- | --- |\n`;

        Array.from(bySegment.entries())
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, 15)
          .forEach(([segment, items]) => {
            const revVals = items.map((i) => revLatest.get(i.id)).filter((v): v is number => v != null);
            const ebVals = items.map((i) => ebitdaLatest.get(i.id)).filter((v): v is number => v != null);
            const avgR = revVals.length > 0 ? revVals.reduce((s, v) => s + v, 0) / revVals.length : 0;
            const avgE = ebVals.length > 0 ? ebVals.reduce((s, v) => s + v, 0) / ebVals.length : 0;
            result += `| ${segment} | ${items.length} | ${avgR.toFixed(1)} | ${avgE.toFixed(1)} |\n`;
          });
      }

      if (group_by === "geography") {
        const byGeo = new Map<string, typeof companies>();
        companies.forEach((c) => {
          const key = c.geography || "Unknown";
          if (!byGeo.has(key)) byGeo.set(key, []);
          byGeo.get(key)!.push(c);
        });

        result += `\n**By Geography:**\n\n`;
        result += `| Geography | Count | Avg Rev ($M) | Avg EBITDA ($M) |\n`;
        result += `| --- | --- | --- | --- |\n`;

        Array.from(byGeo.entries())
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, 15)
          .forEach(([geo, items]) => {
            const revVals = items.map((i) => revLatest.get(i.id)).filter((v): v is number => v != null);
            const ebVals = items.map((i) => ebitdaLatest.get(i.id)).filter((v): v is number => v != null);
            const avgR = revVals.length > 0 ? revVals.reduce((s, v) => s + v, 0) / revVals.length : 0;
            const avgE = ebVals.length > 0 ? ebVals.reduce((s, v) => s + v, 0) / ebVals.length : 0;
            result += `| ${geo} | ${items.length} | ${avgR.toFixed(1)} | ${avgE.toFixed(1)} |\n`;
          });
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
    description: `Get aggregate statistics for companies in the database.

Use this to get summaries, averages, and breakdowns by segment or geography.

Args:
    group_by: Optional grouping - "segment" or "geography"

Returns:
    Summary statistics and breakdowns.`,
    schema: z.object({
      group_by: z
        .string()
        .optional()
        .describe("Group by 'segment' or 'geography'"),
    }),
  }
);
