import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";
import { logger } from "../../logger";

const fmtAmount = (n: number | null | undefined) =>
  n != null ? n.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "-";
const fmtMult = (n: number | null | undefined) => (n != null ? `${n.toFixed(2)}x` : "-");
const fmtPct = (n: number | null | undefined) => (n != null ? `${(n * 100).toFixed(1)}%` : "-");

/**
 * List the workspace's investors (LPs / holding entities) with their aggregate
 * returns for the investment Copilot. Read-only.
 */
export const queryInvestors = tool(
  async () => {
    logger.debug("🔧 TOOL CALLED: query_investors()");

    try {
      const { holdingEntityService } = createContainer(createDb(), await getActiveWorkspaceId());
      const investors = await holdingEntityService.listHoldingEntities();

      if (investors.length === 0) {
        return "No investors (LPs) found in this workspace.";
      }

      let out = `**Investors / LPs (${investors.length}):**\n\n`;
      out += `| Investor | Type | Invested | Realized | FMV | DPI | MOIC | IRR |\n`;
      out += `| --- | --- | --- | --- | --- | --- | --- | --- |\n`;
      for (const inv of investors) {
        out += `| ${inv.name} | ${inv.entity_type ?? "-"} | ${fmtAmount(inv.invested_amount)} | ${fmtAmount(
          inv.realized_amount,
        )} | ${fmtAmount(inv.fmv_amount)} | ${fmtMult(inv.dpi)} | ${fmtMult(inv.moic)} | ${fmtPct(
          inv.irr,
        )} |\n`;
      }
      out += `\nAmounts reflect each investor's aggregate commitments across funds.`;

      logger.debug(`✓ query_investors returned ${investors.length} investor(s)`);
      return out;
    } catch (error) {
      logger.error(`query_investors error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "query_investors",
    description: `List the investors / limited partners (LPs) in this workspace with their aggregate returns (invested, realized, FMV, DPI, MOIC, IRR).

Use this for LP-level questions ("who are our investors?", "which LP has the most capital deployed?", "show investor returns").

Returns:
    A markdown table, one row per investor.`,
  },
);
