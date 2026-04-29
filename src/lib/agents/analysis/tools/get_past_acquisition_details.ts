import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { logger } from "../../logger";
import { createDb } from "@/lib/server/db";
import { PastAcquisitionRepository } from "@/lib/repositories";

/**
 * Get details of a specific past acquisition.
 */
export const getPastAcquisitionDetails = tool(
  async ({ project_name }: { project_name: string }) => {
    logger.debug(`🔧 TOOL CALLED: get_past_acquisition_details(project_name='${project_name}')`);

    try {
      const pastRepo = new PastAcquisitionRepository(createDb());
      const a = await pastRepo.findByNameFuzzy(project_name);
      if (!a) {
        return `No past acquisition found matching "${project_name}". Try a different search term or use query_past_acquisitions to browse available deals.`;
      }

      const result = `## Past Acquisition Details: ${a.project_name || "Unknown"}

### Basic Information
- **No:** ${a.no || "N/A"}
- **Project Type:** ${a.project_type || "N/A"}
- **Target Company/Partner:** ${a.target_co_partner || "N/A"}
- **Seller:** ${a.seller || "N/A"}
- **Target Company Type:** ${a.target_co_company_type || "N/A"}
- **Country:** ${a.country || "N/A"}
- **Sector:** ${a.sector || "N/A"}
- **Year:** ${a.year || "N/A"}

### Deal Metrics
- **EV (100%):** $${a.ev_100_pct_usd_m || "N/A"}M
- **Equity Value:** $${a.equity_value || "N/A"}M
- **Estimated Debt:** $${a.estimated_debt_usd_m || "N/A"}M
- **Investment Value:** $${a.investment_value || "N/A"}M
- **Stake:** ${a.stake || "N/A"}

### Financial Performance
- **Revenue:** $${a.revenue_usd_m || "N/A"}M
- **EBITDA:** $${a.ebitda_usd_m || "N/A"}M
- **Net Income:** $${a.net_income_usd_m || "N/A"}M
- **EBITDA Margin:** ${a.ebitda_margin_pct || "N/A"}%
- **NIM:** ${a.nim_pct || "N/A"}%
- **FCF Conversion:** ${a.fcf_conv || "N/A"}

### Historical Financials
| Year | 2021 | 2022 | 2023 | 2024 |
| --- | --- | --- | --- | --- |
| Revenue ($M) | ${a.revenue_2021_usd_m || "-"} | ${a.revenue_2022_usd_m || "-"} | ${a.revenue_2023_usd_m || "-"} | ${a.revenue_2024_usd_m || "-"} |
| EBITDA ($M) | ${a.ebitda_2021_usd_m || "-"} | ${a.ebitda_2022_usd_m || "-"} | ${a.ebitda_2023_usd_m || "-"} | ${a.ebitda_2024_usd_m || "-"} |
| EBITDA Margin | ${a.ebitda_margin_2021 || "-"} | ${a.ebitda_margin_2022 || "-"} | ${a.ebitda_margin_2023 || "-"} | ${a.ebitda_margin_2024 || "-"} |

### Growth Metrics
- **2021-2022 CAGR:** ${a.cagr_2021_2022 || "N/A"}
- **2022-2023 CAGR:** ${a.cagr_2022_2023 || "N/A"}
- **2023-2024 CAGR:** ${a.cagr_2023_2024 || "N/A"}
- **Revenue CAGR (L3Y):** ${a.revenue_cagr_l3y || "N/A"}
- **Revenue Drop Count:** ${a.revenue_drop_count || "N/A"}

### Status & Screening
- **Internal Stage:** ${a.internal_stage || "N/A"}
- **Status:** ${a.status || "N/A"}
- **Prioritization:** ${a.prioritization || "N/A"}
- **Source:** ${a.source || "N/A"} (${a.type_of_source || "N/A"})
- **Internal Source:** ${a.internal_source || "N/A"}
- **Name of Advisors:** ${a.name_of_advisors || "N/A"}

### Screening Results
- **L0 Date:** ${a.l0_date || "N/A"}
- **Pass L0 Screening:** ${a.pass_l0_screening || "N/A"}
- **Reason to Drop:** ${a.reason_to_drop || "N/A"}
- **On Hold Reason:** ${a.on_hold_reason || "N/A"}

### L1 Criteria Assessment
- **Vision Alignment (>25% priority revenue):** ${a.vision_alignment_25pct_revenue || "N/A"}
- **Priority Geography (>50% US/JP/KR/TW/CN/ID):** ${a.priority_geography_50pct_revenue || "N/A"}
- **EV Value (<$1B):** ${a.ev_value_under_1b || "N/A"}
- **Revenue Stability (no consecutive drop):** ${a.revenue_stability_no_consecutive_drop || "N/A"}
- **EBITDA >10% over L3Y:** ${a.ebitda_over_10pct_l3y || "N/A"}
- **Pass All 5 L1 Criteria:** ${a.pass_all_5_l1_criteria || "N/A"}
- **Willingness to Sell:** ${a.willingness_to_sell || "N/A"}

### Product & Strategic Fit
- **Main Products:** ${a.main_products || "N/A"}
- **Company Website:** ${a.company_website || "N/A"}
- **Fit with Priority Product Groups:** ${a.fit_with_priority_product_groups || "N/A"}
- **Details on Product Fit:** ${a.details_on_product_fit || "N/A"}
- **% Revenue from Priority Segments:** ${a.pct_revenue_from_priority_segments || "N/A"}
- **Geography Breakdown:** ${a.geography_breakdown_of_revenue || "N/A"}

${a.comments ? `### Comments\n${a.comments}` : ""}
${a.assumption ? `### Assumptions\n${a.assumption}` : ""}
`;

      logger.debug("✓ Past acquisition details retrieved");
      return result;
    } catch (error) {
      logger.error(`Details error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "get_past_acquisition_details",
    description: `Get detailed information about a specific past acquisition by project name.

Use this when the user asks about a specific historical deal's details, screening criteria, or outcomes.

Args:
    project_name: The name (or partial name) of the project/deal to look up

Returns:
    Complete deal profile with all available financial data, screening results, and strategic fit assessment.`,
    schema: z.object({
      project_name: z.string().describe("Project name to look up"),
    }),
  }
);
