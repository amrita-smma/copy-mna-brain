import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { z } from "zod";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";
import { logger } from "../../logger";
import { fuzzySearch } from "./fuzzySearch";

const fmtAmount = (n: number | null | undefined) =>
  n != null ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "-";
const fmtMult = (n: number | null | undefined) => (n != null ? `${n.toFixed(2)}x` : "-");
const fmtPct = (n: number | null | undefined) => (n != null ? `${(n * 100).toFixed(1)}%` : "-");

/**
 * List fund assets (holdings) for the investment Copilot. With no `fund`, lists
 * every asset across all funds (plus any unassigned assets); with a `fund` name
 * it drills into that fund's holdings. Read-only.
 */
export const queryFundAssets = tool(
  async ({ fund, status }: { fund?: string; status?: string }) => {
    logger.debug(`🔧 TOOL CALLED: query_fund_assets(fund='${fund ?? ""}', status='${status ?? ""}')`);

    try {
      const { fundService } = createContainer(createDb(), await getActiveWorkspaceId());
      const funds = await fundService.listFunds();

      // Resolve which funds to pull assets from. Fuzzy so "growth 2",
      // "Growth Fund II, L.P." and a typo all land on the same fund.
      let targetFunds = funds;
      if (fund) {
        targetFunds = fuzzySearch(fund, funds, (f) => [f.name]).map((m) => m.item);
        if (targetFunds.length === 0) {
          return (
            `No fund found matching "${fund}". Use query_funds to see available funds, ` +
            `or search_investments to check whether "${fund}" is a holding, investor, or capital source instead.`
          );
        }
      }

      const fundNameById = new Map(funds.map((f) => [f.id, f.name]));
      // ONE batched query for every target fund — never listAssets per fund
      // (that fan-out is an N+1 that exhausts the connection pool).
      const pairs = await fundService.listAssetsForFunds(targetFunds.map((f) => f.id));
      const rows: Array<{ fundName: string; asset: (typeof pairs)[number]['asset'] }> = pairs.map(
        ({ fundId, asset }) => ({ fundName: fundNameById.get(fundId) ?? "-", asset }),
      );

      // Only fold in unassigned assets on an unfiltered, portfolio-wide listing.
      if (!fund) {
        const unassigned = await fundService.listUnassignedAssets();
        for (const a of unassigned) rows.push({ fundName: "(unassigned)", asset: a });
      }

      let filtered = rows;
      if (status) {
        const wanted = status.trim().toLowerCase();
        filtered = rows.filter((r) => (r.asset.status ?? "").toLowerCase() === wanted);
      }

      if (filtered.length === 0) {
        return "No fund assets found for the given filters.";
      }

      let out = `**Fund assets (${filtered.length}):**\n\n`;
      out += `| Asset | Fund | Type | Sector | Status | Invested | Distributed | FMV | MOIC | DPI | IRR |\n`;
      out += `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
      for (const { fundName, asset: a } of filtered) {
        out += `| ${a.asset_name} | ${fundName} | ${a.asset_type ?? "-"} | ${a.sector ?? "-"} | ${
          a.status ?? "-"
        } | ${fmtAmount(a.invested_capital_amount)} | ${fmtAmount(
          a.net_distribution_amount,
        )} | ${fmtAmount(a.fmv_amount)} | ${fmtMult(a.gross_moic)} | ${fmtMult(a.dpi)} | ${fmtPct(
          a.gross_irr,
        )} |\n`;
      }
      out += `\nAmounts are in each asset's report currency.`;

      logger.debug(`✓ query_fund_assets returned ${filtered.length} asset(s)`);
      return out;
    } catch (error) {
      logger.error(`query_fund_assets error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "query_fund_assets",
    description: `List the assets (holdings) held across funds, with per-asset performance (invested capital, distributions, FMV, MOIC, DPI, IRR).

Use this for holding-level questions ("what are our largest positions?", "show the assets in Fund II", "which holdings are exited?"). Omit \`fund\` to list every asset across all funds (including any unassigned assets); pass \`fund\` to drill into one fund. To look up ONE holding by name, use search_investments (which also tells you if the name is really a fund/investor/source) or get_fund_asset_details.

Args:
    fund: Optional fund name to scope to one fund's holdings. Matched fuzzily — case, punctuation, legal suffixes, partial words, and small typos are all tolerated.
    status: Optional asset status filter (e.g. "active", "exited", "pending").

Returns:
    A markdown table, one row per asset.`,
    schema: z.object({
      fund: z
        .string()
        .optional()
        .describe(
          "Optional fund name (fuzzy match) to scope to a single fund's holdings",
        ),
      status: z
        .string()
        .optional()
        .describe('Optional asset status filter, e.g. "active", "exited", "pending"'),
    }),
  },
);
