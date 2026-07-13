import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { z } from "zod";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";
import { logger } from "../../logger";

const fmtAmount = (n: number | null | undefined) =>
  n != null ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "-";
const fmtMult = (n: number | null | undefined) => (n != null ? `${n.toFixed(2)}x` : "-");
const fmtPct = (n: number | null | undefined) => (n != null ? `${(n * 100).toFixed(1)}%` : "-");

/**
 * List the workspace's funds with their headline metrics for the investment
 * Copilot. Read-only; optionally filters by status.
 */
export const queryFunds = tool(
  async ({ status }: { status?: string }) => {
    logger.debug(`🔧 TOOL CALLED: query_funds(status='${status ?? ""}')`);

    try {
      const { fundService } = createContainer(createDb(), await getActiveWorkspaceId());
      let funds = await fundService.listFunds();

      if (status) {
        const wanted = status.trim().toLowerCase();
        funds = funds.filter((f) => (f.status ?? "").toLowerCase() === wanted);
      }

      if (funds.length === 0) {
        return status
          ? `No funds found with status "${status}".`
          : "No funds found in this workspace.";
      }

      let out = `**Funds (${funds.length}):**\n\n`;
      out += `| Fund | Vintage | Status | Commitment | Called | FMV | Realized | DPI | TVPI | IRR |\n`;
      out += `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
      for (const f of funds) {
        out += `| ${f.name} | ${f.vintage_year ?? "-"} | ${f.status ?? "-"} | ${fmtAmount(
          f.commitment_size_amount,
        )} | ${fmtAmount(f.called_amount)} | ${fmtAmount(f.fmv_amount)} | ${fmtAmount(
          f.realized_amount,
        )} | ${fmtMult(f.dpi)} | ${fmtMult(f.tvpi)} | ${fmtPct(f.irr)} |\n`;
      }
      out += `\nAmounts are in each fund's base currency. Use query_fund_assets with a fund name to drill into its holdings.`;

      logger.debug(`✓ query_funds returned ${funds.length} fund(s)`);
      return out;
    } catch (error) {
      logger.error(`query_funds error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "query_funds",
    description: `List the funds in this workspace with their headline performance metrics (commitment, called, FMV, realized, DPI, TVPI, IRR).

Use this for portfolio-level questions ("what funds do we have?", "which fund has the best TVPI?", "show me our harvesting funds"). To inspect the holdings inside a fund, follow up with query_fund_assets.

Args:
    status: Optional fund status filter (e.g. "investing", "harvesting", "closed").

Returns:
    A markdown table, one row per fund.`,
    schema: z.object({
      status: z
        .string()
        .optional()
        .describe('Optional fund status filter, e.g. "investing", "harvesting", "closed"'),
    }),
  },
);
