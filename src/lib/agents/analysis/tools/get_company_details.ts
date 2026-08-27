import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from '@/lib/workspace';
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import {
  CompanyFinancialRepository,
  CompanyRepository,
  CompanyScreeningDerivedRepository,
} from "@/lib/repositories";
import { buildCompanyMentionsMarker } from "@/lib/navigation/companyMentions";

/**
 * Get detailed information about a specific company.
 */
export const getCompanyDetails = tool(
  async ({ company_name }: { company_name: string }) => {
    logger.debug(`🔧 TOOL CALLED: get_company_details(company_name='${company_name}')`);

    const trimmed = company_name?.trim() ?? "";
    if (trimmed.length === 0) {
      return "Please provide a company target name or project name to look up. Use query_companies to browse available companies.";
    }

    try {
      const db = createDb();
      const companyRepo = new CompanyRepository(db, await getActiveWorkspaceId());
      const financialRepo = new CompanyFinancialRepository(db, await getActiveWorkspaceId());
      const screeningRepo = new CompanyScreeningDerivedRepository(db, await getActiveWorkspaceId());
      const c = await companyRepo.findByNameFuzzy(trimmed);

      if (!c) {
        return `No company found matching "${trimmed}". Try a different search term or use query_companies to browse available companies.`;
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
- **Company ID (UUID):** ${c.id}
- **Entry ID:** ${c.entry_id || "N/A"}
- **Project Name:** ${c.project_name || "N/A"}
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
      // Hidden id↔name manifest so the chat UI can offer an "Open <company>"
      // chip when the answer names this company. See `companyMentions`.
      const mentionsMarker = buildCompanyMentionsMarker(
        [c.target, c.project_name]
          .filter((name): name is string => !!name?.trim())
          .map((name) => ({ id: c.id, name })),
      );
      return mentionsMarker ? `${result}\n${mentionsMarker}` : result;
    } catch (error) {
      logger.error(`Details error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "get_company_details",
    description: `Get detailed information about a specific company by name or project name.

Use this when the user asks about a specific company's financials, details, or history.
Matches case-insensitively against both the company target name and the project name.

Also use this to resolve a company's ID (UUID) from its name — the returned
"Company ID (UUID)" is the company_id required by tools like
update_company_card_section when it wasn't supplied directly.

Args:
    company_name: The company target name or project name (partial match) to look up

Returns:
    Detailed company profile including the company ID (UUID) and all available financial data.`,
    schema: z.object({
      company_name: z
        .string()
        .min(1)
        .describe("Company target name or project name (partial match, must be non-empty)"),
    }),
  }
);
