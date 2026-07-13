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
 * List the workspace's funding sources (capital pools / sources of fund) with
 * their aggregate returns for the investment Copilot. Read-only.
 */
export const queryFundSources = tool(
  async () => {
    logger.debug("🔧 TOOL CALLED: query_fund_sources()");

    try {
      const { fundSourceService } = createContainer(createDb(), await getActiveWorkspaceId());
      const sources = await fundSourceService.listFundSources();

      if (sources.length === 0) {
        return "No fund sources (capital pools) found in this workspace.";
      }

      let out = `**Fund sources (${sources.length}):**\n\n`;
      out += `| Source | Invested | Realized | FMV | DPI | MOIC | IRR |\n`;
      out += `| --- | --- | --- | --- | --- | --- | --- |\n`;
      for (const s of sources) {
        out += `| ${s.name} | ${fmtAmount(s.invested_amount)} | ${fmtAmount(
          s.realized_amount,
        )} | ${fmtAmount(s.fmv_amount)} | ${fmtMult(s.dpi)} | ${fmtMult(s.moic)} | ${fmtPct(
          s.irr,
        )} |\n`;
      }
      out += `\nAmounts reflect each source's aggregate capital deployed across funds.`;

      logger.debug(`✓ query_fund_sources returned ${sources.length} source(s)`);
      return out;
    } catch (error) {
      logger.error(`query_fund_sources error: ${(error as Error).message}`);
      return `**Error:** ${(error as Error).message}`;
    }
  },
  {
    name: "query_fund_sources",
    description: `List the funding sources (capital pools / "sources of fund") in this workspace with their aggregate returns (invested, realized, FMV, DPI, MOIC, IRR).

Use this for capital-source questions ("what are our sources of capital?", "how much has each source deployed?", "which pool has the best MOIC?").

Returns:
    A markdown table, one row per funding source.`,
  },
);
