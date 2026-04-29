import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { PastAcquisitionRepository } from "@/lib/repositories";

/**
 * Compare a company against past acquisitions to evaluate fit.
 */
export const compareWithPastAcquisitions = tool(
  async ({
    company_name,
    sector,
    country,
    revenue_usd_m,
    ebitda_usd_m,
    ebitda_margin_pct,
    ev_usd_m,
  }: {
    company_name: string;
    sector?: string;
    country?: string;
    revenue_usd_m?: number;
    ebitda_usd_m?: number;
    ebitda_margin_pct?: number;
    ev_usd_m?: number;
  }) => {
    logger.debug(
      `🔧 TOOL CALLED: compare_with_past_acquisitions(company='${company_name}', sector='${sector}')`
    );

    try {
      const pastRepo = new PastAcquisitionRepository(createDb());
      const acquisitions = await pastRepo.findAll();
      if (!acquisitions || acquisitions.length === 0) {
        return "No past acquisitions data available for comparison.";
      }

      let comparableDeals = acquisitions;
      if (sector) {
        const sectorLower = sector.toLowerCase();
        comparableDeals = acquisitions.filter(
          (a) => a.sector?.toLowerCase().includes(sectorLower)
        );
      }
      if (country) {
        const countryLower = country.toLowerCase();
        comparableDeals = comparableDeals.filter(
          (a) => a.country?.toLowerCase().includes(countryLower)
        );
      }

      const parseNumeric = (val: string | null | undefined): number | null => {
        if (!val) return null;
        const num = parseFloat(val.replace(/[,$%]/g, ""));
        return isNaN(num) ? null : num;
      };

      const evValues = comparableDeals.map((a) => parseNumeric(a.ev_100_pct_usd_m)).filter((v): v is number => v !== null);
      const revValues = comparableDeals.map((a) => parseNumeric(a.revenue_usd_m)).filter((v): v is number => v !== null);
      const ebitdaValues = comparableDeals.map((a) => parseNumeric(a.ebitda_usd_m)).filter((v): v is number => v !== null);
      const marginValues = comparableDeals.map((a) => parseNumeric(a.ebitda_margin_pct)).filter((v): v is number => v !== null);

      const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
      const median = (arr: number[]) => {
        if (arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      };
      const min = (arr: number[]) => arr.length > 0 ? Math.min(...arr) : 0;
      const max = (arr: number[]) => arr.length > 0 ? Math.max(...arr) : 0;

      const passedL0 = comparableDeals.filter((a) =>
        a.pass_l0_screening?.toLowerCase() === "yes" || a.pass_l0_screening?.toLowerCase() === "true"
      ).length;
      const passedL1 = comparableDeals.filter((a) =>
        a.pass_all_5_l1_criteria?.toLowerCase() === "yes" || a.pass_all_5_l1_criteria?.toLowerCase() === "true"
      ).length;

      let result = `## Comparison Analysis: ${company_name}\n\n`;
      result += `### Comparable Deals Overview\n`;
      result += `- **Total Past Acquisitions:** ${acquisitions.length}\n`;
      result += `- **Comparable Deals (${sector || "All"} ${country ? `in ${country}` : ""}):** ${comparableDeals.length}\n`;
      result += `- **L0 Screening Pass Rate:** ${comparableDeals.length > 0 ? ((passedL0 / comparableDeals.length) * 100).toFixed(1) : 0}%\n`;
      result += `- **L1 Criteria Pass Rate:** ${comparableDeals.length > 0 ? ((passedL1 / comparableDeals.length) * 100).toFixed(1) : 0}%\n\n`;

      result += `### Historical Deal Metrics (Comparable Deals)\n\n`;
      result += `| Metric | Min | Avg | Median | Max | ${company_name} | Fit |\n`;
      result += `| --- | --- | --- | --- | --- | --- | --- |\n`;

      if (evValues.length > 0) {
        const companyEv = ev_usd_m !== undefined ? ev_usd_m : null;
        const evFit = companyEv !== null
          ? (companyEv >= min(evValues) * 0.5 && companyEv <= max(evValues) * 1.5 ? "✅ Good" : "⚠️ Outside Range")
          : "N/A";
        result += `| EV ($M) | ${min(evValues).toFixed(1)} | ${avg(evValues).toFixed(1)} | ${median(evValues).toFixed(1)} | ${max(evValues).toFixed(1)} | ${companyEv?.toFixed(1) || "N/A"} | ${evFit} |\n`;
      }

      if (revValues.length > 0) {
        const companyRev = revenue_usd_m !== undefined ? revenue_usd_m : null;
        const revFit = companyRev !== null
          ? (companyRev >= min(revValues) * 0.5 && companyRev <= max(revValues) * 1.5 ? "✅ Good" : "⚠️ Outside Range")
          : "N/A";
        result += `| Revenue ($M) | ${min(revValues).toFixed(1)} | ${avg(revValues).toFixed(1)} | ${median(revValues).toFixed(1)} | ${max(revValues).toFixed(1)} | ${companyRev?.toFixed(1) || "N/A"} | ${revFit} |\n`;
      }

      if (ebitdaValues.length > 0) {
        const companyEbitda = ebitda_usd_m !== undefined ? ebitda_usd_m : null;
        const ebitdaFit = companyEbitda !== null
          ? (companyEbitda >= min(ebitdaValues) * 0.5 && companyEbitda <= max(ebitdaValues) * 1.5 ? "✅ Good" : "⚠️ Outside Range")
          : "N/A";
        result += `| EBITDA ($M) | ${min(ebitdaValues).toFixed(1)} | ${avg(ebitdaValues).toFixed(1)} | ${median(ebitdaValues).toFixed(1)} | ${max(ebitdaValues).toFixed(1)} | ${companyEbitda?.toFixed(1) || "N/A"} | ${ebitdaFit} |\n`;
      }

      if (marginValues.length > 0) {
        const companyMargin = ebitda_margin_pct !== undefined ? ebitda_margin_pct : null;
        const marginFit = companyMargin !== null
          ? (companyMargin >= 10 ? "✅ Good" : "⚠️ Below 10%")
          : "N/A";
        result += `| EBITDA Margin (%) | ${min(marginValues).toFixed(1)} | ${avg(marginValues).toFixed(1)} | ${median(marginValues).toFixed(1)} | ${max(marginValues).toFixed(1)} | ${companyMargin?.toFixed(1) || "N/A"} | ${marginFit} |\n`;
      }

      result += `\n### Most Similar Past Deals\n\n`;

      const scoredDeals = comparableDeals.map((deal) => {
        let score = 0;
        const dealEv = parseNumeric(deal.ev_100_pct_usd_m);
        const dealRev = parseNumeric(deal.revenue_usd_m);
        const dealEbitda = parseNumeric(deal.ebitda_usd_m);

        if (ev_usd_m && dealEv) {
          const diff = Math.abs(ev_usd_m - dealEv) / Math.max(ev_usd_m, dealEv);
          score += (1 - Math.min(diff, 1)) * 30;
        }
        if (revenue_usd_m && dealRev) {
          const diff = Math.abs(revenue_usd_m - dealRev) / Math.max(revenue_usd_m, dealRev);
          score += (1 - Math.min(diff, 1)) * 30;
        }
        if (ebitda_usd_m && dealEbitda) {
          const diff = Math.abs(ebitda_usd_m - dealEbitda) / Math.max(ebitda_usd_m, dealEbitda);
          score += (1 - Math.min(diff, 1)) * 40;
        }

        return { deal, score };
      });

      const topDeals = scoredDeals
        .filter((d) => d.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      if (topDeals.length > 0) {
        result += `| Project Name | Sector | EV ($M) | Revenue ($M) | EBITDA ($M) | Status | Similarity |\n`;
        result += `| --- | --- | --- | --- | --- | --- | --- |\n`;
        topDeals.forEach(({ deal, score }) => {
          result += `| ${deal.project_name || "N/A"} | ${deal.sector || "-"} | ${deal.ev_100_pct_usd_m || "-"} | ${deal.revenue_usd_m || "-"} | ${deal.ebitda_usd_m || "-"} | ${deal.status || "-"} | ${score.toFixed(0)}% |\n`;
        });
      } else {
        result += "No similar deals found. Provide financial metrics for better matching.\n";
      }

      result += `\n### Overall Assessment\n\n`;
      const assessmentPoints: string[] = [];

      if (ev_usd_m !== undefined && evValues.length > 0) {
        if (ev_usd_m <= 1000) {
          assessmentPoints.push("✅ EV under $1B - meets size criteria");
        } else {
          assessmentPoints.push("⚠️ EV over $1B - may exceed typical deal size");
        }
      }

      if (ebitda_margin_pct !== undefined) {
        if (ebitda_margin_pct >= 10) {
          assessmentPoints.push("✅ EBITDA margin >10% - meets profitability criteria");
        } else {
          assessmentPoints.push("⚠️ EBITDA margin <10% - below typical threshold");
        }
      }

      if (comparableDeals.length >= 3) {
        assessmentPoints.push(`📊 ${comparableDeals.length} comparable past deals found for reference`);
      } else if (comparableDeals.length > 0) {
        assessmentPoints.push(`📊 Limited comparable deals (${comparableDeals.length}) - consider broader comparison`);
      }

      result += assessmentPoints.length > 0 ? assessmentPoints.join("\n") : "Provide more details for a complete assessment.";

      logger.debug("✓ Comparison analysis completed");
      return result;
    } catch (error) {
      logger.error(`Comparison error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "compare_with_past_acquisitions",
    description: `Compare a company against past acquisitions to evaluate strategic fit.

Use this tool when the user wants to:
- Evaluate if a company fits historical deal patterns
- Compare a target's metrics against past acquisition benchmarks
- Find similar past deals for reference
- Assess if a company meets typical screening criteria

Args:
    company_name: Name of the company to evaluate (required)
    sector: Company's sector for filtering comparable deals
    country: Company's country for filtering comparable deals
    revenue_usd_m: Company's revenue in USD millions
    ebitda_usd_m: Company's EBITDA in USD millions
    ebitda_margin_pct: Company's EBITDA margin percentage
    ev_usd_m: Company's enterprise value in USD millions

Returns:
    Detailed comparison analysis including:
    - Historical deal statistics from comparable acquisitions
    - Fit assessment against typical deal metrics
    - Most similar past deals
    - Overall strategic fit assessment`,
    schema: z.object({
      company_name: z.string().describe("Name of the company to evaluate"),
      sector: z.string().optional().describe("Company's sector"),
      country: z.string().optional().describe("Company's country"),
      revenue_usd_m: z.number().optional().describe("Revenue in USD millions"),
      ebitda_usd_m: z.number().optional().describe("EBITDA in USD millions"),
      ebitda_margin_pct: z.number().optional().describe("EBITDA margin percentage"),
      ev_usd_m: z.number().optional().describe("Enterprise value in USD millions"),
    }),
  }
);
