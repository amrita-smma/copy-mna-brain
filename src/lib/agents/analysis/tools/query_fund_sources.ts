import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { createDb } from "@/lib/server/db";
import {
  flAdd,
  flDiv,
  flIsNegative,
  flIsPositive,
  flIsZero,
  flSub,
  toDecimalString,
} from "@/lib/services/flDecimal";
import { logger } from "../../logger";

const fmtAmount = (val: string | null | undefined) => {
  if (val == null) return "-";
  try {
    const rounded = toDecimalString(val, 0);
    const isNeg = rounded.startsWith("-");
    const digits = isNeg ? rounded.slice(1) : rounded;
    const formatted = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return isNeg ? `-${formatted}` : formatted;
  } catch {
    return "-";
  }
};

const fmtMult = (val: string | null | undefined) => {
  if (val == null) return "-";
  try {
    const numStr = toDecimalString(val, 2);
    return `${numStr}x`;
  } catch {
    return "-";
  }
};

const fmtPct = (val: string | null | undefined) => {
  if (val == null) return "-";
  try {
    const numStr = toDecimalString(val, 1);
    return `${numStr}%`;
  } catch {
    return "-";
  }
};

/**
 * List the workspace's funding sources (capital pools / sources of fund) with
 * their aggregate returns for the investment Copilot using Fund Ledger v2. Read-only.
 */
export const queryFundSources = tool(
  async () => {
    logger.debug("🔧 TOOL CALLED: query_fund_sources()");

    try {
      const workspaceId = await getActiveWorkspaceId();
      // Resolved lazily to keep this tool off the container's static import
      // cycle (see TECH_DEBT.md "Runtime import cycle").
      const { createContainer } = await import("@/lib/services/container");
      const { flPortfolioService } = createContainer(createDb(), workspaceId);
      const portfolio = await flPortfolioService.getPortfolio(workspaceId);
      const sources = portfolio.funding_sources ?? [];

      if (sources.length === 0) {
        return "No fund sources (capital pools) found in this workspace.";
      }

      // Pre-aggregate FMV: only sourced positions contribute current_value
      const fmvBySourceId = new Map<string, string>();
      for (const pos of portfolio.positions ?? []) {
        if (pos.holder_source_of_fund_id) {
          const fmv = String(pos.current_value ?? '0');
          fmvBySourceId.set(
            pos.holder_source_of_fund_id,
            flAdd(fmvBySourceId.get(pos.holder_source_of_fund_id) ?? '0', fmv),
          );
        }
      }

      // Pre-aggregate allocations: authoritative for deployed and realized
      const deployedBySourceId = new Map<string, string>();
      const realizedBySourceId = new Map<string, string>();

      for (const entry of portfolio.entries ?? []) {
        const isDeploy =
          entry.entry_type === "buy" ||
          entry.entry_type === "paid_in" ||
          entry.entry_type === "expense";

        const isRealize =
          entry.entry_type === "sell" ||
          entry.entry_type === "distribution" ||
          entry.entry_type === "redemption" ||
          entry.entry_type === "income";

        // For non-standard entry types (e.g. adjustment), use cash delta direction before reversal
        const cashDelta = String(entry.cash_delta ?? '0');
        const fallbackDeploy =
          !isDeploy &&
          !isRealize &&
          (entry.is_reversal
            ? flIsPositive(cashDelta)
            : flIsNegative(cashDelta));
        const fallbackRealize =
          !isDeploy &&
          !isRealize &&
          !fallbackDeploy &&
          (entry.is_reversal
            ? flIsNegative(cashDelta)
            : flIsPositive(cashDelta));

        const deploySide = isDeploy || fallbackDeploy;
        const realizeSide = isRealize || fallbackRealize;

        for (const alloc of entry.allocations ?? []) {
          const srcId = alloc.funding_source_id;
          const amt = String(alloc.amount ?? '0');
          if (!srcId || flIsZero(amt)) continue;

          if (deploySide) {
            const current = deployedBySourceId.get(srcId) ?? '0';
            deployedBySourceId.set(
              srcId,
              entry.is_reversal ? flSub(current, amt) : flAdd(current, amt),
            );
          } else if (realizeSide) {
            const current = realizedBySourceId.get(srcId) ?? '0';
            realizedBySourceId.set(
              srcId,
              entry.is_reversal ? flSub(current, amt) : flAdd(current, amt),
            );
          }
        }
      }

      let out = `**Fund sources (${sources.length}):**\n\n`;
      out += `| Source | Invested | Realized | FMV | DPI | MOIC | IRR |\n`;
      out += `| --- | --- | --- | --- | --- | --- | --- |\n`;
      for (const s of sources) {
        const rawDeployed = deployedBySourceId.get(s.id) ?? '0';
        const deployed = flIsNegative(rawDeployed) ? '0' : rawDeployed;
        const rawRealized = realizedBySourceId.get(s.id) ?? '0';
        const realized = flIsNegative(rawRealized) ? '0' : rawRealized;
        const fmv = fmvBySourceId.get(s.id) ?? '0';
        const hasDeployed = flIsPositive(deployed);
        const dpi = hasDeployed ? flDiv(realized, deployed, 2) : null;
        const moic = hasDeployed ? flDiv(flAdd(fmv, realized), deployed, 2) : null;
        const irr = null;

        out += `| ${s.name} | ${fmtAmount(deployed)} | ${fmtAmount(
          realized,
        )} | ${fmtAmount(fmv)} | ${fmtMult(dpi)} | ${fmtMult(moic)} | ${fmtPct(
          irr,
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
