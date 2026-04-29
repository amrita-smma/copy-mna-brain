import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import {
  CompanyFinancialRepository,
  CompanyRepository,
  CompanyScreeningDerivedRepository,
} from "@/lib/repositories";

/**
 * Get detailed information about a specific company.
 */
export const getCompanyDetails = tool(
  async ({ company_name }: { company_name: string }) => {
    logger.debug(`🔧 TOOL CALLED: get_company_details(company_name='${company_name}')`);

    try {
      const db = createDb();
      const companyRepo = new CompanyRepository(db);
      const financialRepo = new CompanyFinancialRepository(db);
      const screeningRepo = new CompanyScreeningDerivedRepository(db);
      const c = await companyRepo.findByNameFuzzy(company_name);

      if (!c) {
        return `No company found matching "${company_name}". Try a different search term or use query_companies to browse available companies.`;
      }

      const [financials, screening] = await Promise.all([
        financialRepo.findByCompany(c.id),
        screeningRepo.findByCompany(c.id),
      ]);
      const byYear = new Map<number, typeof financials[number]>();
      for (const row of financials) byYear.set(row.fiscal_year, row);
      const fmtNum = (n: number | null | undefined, digits = 1) =>
        n != null ? n.toFixed(digits) : "-";
      const fmtPct = (n: number | null | undefined) =>
        n != null ? (n * 100).toFixed(1) + "%" : "-";

      const sortedYears = Array.from(byYear.keys()).sort((a, b) => a - b);
      const displayYears = sortedYears.slice(-4);
      const latestYear = displayYears[displayYears.length - 1];
      const latestRow = latestYear != null ? byYear.get(latestYear) : undefined;

      const yearHeader = displayYears.join(" | ");
      const sep = displayYears.map(() => "---").join(" | ");
      const revenueRow = displayYears.map((y) => fmtNum(byYear.get(y)?.revenue_usd_mn)).join(" | ");
      const growthRow = displayYears.map((y, i) => i === 0 ? "-" : fmtPct(byYear.get(y)?.revenue_cagr_vs_prior)).join(" | ");
      const ebitdaRow = displayYears.map((y) => fmtNum(byYear.get(y)?.ebitda_usd_mn)).join(" | ");
      const marginRow = displayYears.map((y) => fmtPct(byYear.get(y)?.ebitda_margin)).join(" | ");

      const result = `## Company Details: ${c.target || "Unknown"}

### Basic Information
- **Entry ID:** ${c.entry_id || "N/A"}
- **Segment:** ${c.segment || "N/A"}
- **Company Focus:** ${c.company_focus || "N/A"}
- **Geography:** ${c.geography || "N/A"}
- **Ownership:** ${c.ownership || "N/A"}
- **Website:** ${c.website || "N/A"}
- **Watchlist Status:** ${c.watchlist_status || "N/A"}
- **Pipeline Stage:** ${c.pipeline_stage || "N/A"}

### Revenue (USD Millions)
| Year | ${yearHeader} |
| --- | ${sep} |
| Revenue | ${revenueRow} |
| Growth | ${growthRow} |

### EBITDA (USD Millions)
| Year | ${yearHeader} |
| --- | ${sep} |
| EBITDA | ${ebitdaRow} |
| Margin | ${marginRow} |

### Valuation (Latest Year${latestYear != null ? ` ${latestYear}` : ""})
- **Enterprise Value:** ${latestRow?.ev_usd_mn != null ? "$" + latestRow.ev_usd_mn.toFixed(1) + "M" : "N/A"}
- **EV/EBITDA Multiple:** ${fmtNum(latestRow?.ev_ebitda)}x

${screening?.l1_screening_result ? `### L1 Screening\n- **Result:** ${screening.l1_screening_result}${screening.l1_rationale ? `\n- **Rationale:** ${screening.l1_rationale}` : ""}\n` : ""}
${c.comments ? `### Comments\n${c.comments}` : ""}
`;

      logger.debug("✓ Company details retrieved");
      return result;
    } catch (error) {
      logger.error(`Details error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "get_company_details",
    description: `Get detailed information about a specific company by name.

Use this when the user asks about a specific company's financials, details, or history.

Args:
    company_name: The name (or partial name) of the company to look up

Returns:
    Detailed company profile with all available financial data.`,
    schema: z.object({
      company_name: z.string().describe("Company name to look up"),
    }),
  }
);
