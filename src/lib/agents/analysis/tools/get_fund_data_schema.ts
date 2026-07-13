import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";
import { logger } from "../../logger";

/**
 * Describe the fund/investment data model to the investment Copilot so it knows
 * which read tools to reach for. Mirrors get_data_schema (companies) but for the
 * funds domain: funds, fund assets/holdings, investors (LPs), and fund sources.
 */
export const getFundDataSchema = tool(
  async () => {
    logger.debug("🔧 TOOL CALLED: get_fund_data_schema()");

    let fundCount = 0;
    try {
      const { fundService } = createContainer(createDb(), await getActiveWorkspaceId());
      fundCount = (await fundService.listFunds()).length;
    } catch (error) {
      logger.error(`Error getting fund count: ${(error as Error).message}`);
    }

    const result = `## Fund & Investment Data Schema

This workspace currently tracks **${fundCount}** fund(s). All monetary metrics are
expressed in each entity's report/base currency; ratios (DPI, TVPI, MOIC) are
multiples and IRR is a fraction (0.15 = 15%).

### funds — the investment vehicles (query with \`query_funds\`)
- name, description, vintage_year, status (investing / harvesting / closed)
- commitment_size_amount, base_currency
- Rolled-up metrics: called_amount, fmv_amount, realized_amount, dpi, tvpi, irr

### fund_assets — the holdings inside a fund (query with \`query_fund_assets\`)
- asset_name, legal_name, asset_type (direct_investment / cash / fund_of_funds)
- sector, sub_sector, country, status (active / exited / pending)
- entry_date, stake_pct, investment_currency, report_currency
- Rolled-up metrics: invested_capital_amount, net_distribution_amount,
  fmv_amount, gross_moic, gross_irr, dpi, share_count, current_price_per_share

### holding_entities — the investors / LPs (query with \`query_investors\`)
- name, entity_type
- Rolled-up metrics: invested_amount, realized_amount, fmv_amount, dpi, moic, irr

### funding_sources — capital pools / sources of fund (query with \`query_fund_sources\`)
- name
- Rolled-up metrics: invested_amount, realized_amount, fmv_amount, dpi, moic, irr

Use \`web_search\` for external market data, benchmarks, and comparables not held
in these tables.`;

    logger.debug("✓ Fund schema retrieved");
    return result;
  },
  {
    name: "get_fund_data_schema",
    description: `Get the fund/investment data model (funds, fund assets/holdings, investors/LPs, and fund sources) and the metrics available on each. Call this first when you're unsure which fund tool to use or what fields exist.`,
  },
);
