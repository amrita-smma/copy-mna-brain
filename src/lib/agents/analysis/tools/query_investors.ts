import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";
import { flAdd, flDiv, flIsPositive, toDecimalString } from "@/lib/services/flDecimal";
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
 * List the workspace's investors (LPs / holding entities) with their aggregate
 * returns for the investment Copilot using Fund Ledger v2. Read-only.
 */
export const queryInvestors = tool(
  async () => {
    logger.debug("🔧 TOOL CALLED: query_investors()");

    try {
      const workspaceId = await getActiveWorkspaceId();
      const { flPortfolioService } = createContainer(createDb(), workspaceId);
      const portfolio = await flPortfolioService.getPortfolio(workspaceId);
      const investors = portfolio.investors ?? [];

      if (investors.length === 0) {
        return "No investors (LPs) found in this workspace.";
      }

      // Pre-aggregate positions held by investor
      const investedByInvestorId = new Map<string, string>();
      const realizedByInvestorId = new Map<string, string>();
      const fmvByInvestorId = new Map<string, string>();

      for (const pos of portfolio.positions ?? []) {
        if (pos.holder_investor_id) {
          const invested = String(pos.balance?.drawn_commitment ?? pos.balance?.contributed ?? '0');
          const realized = String(pos.balance?.distributed_capital ?? pos.balance?.distributed ?? '0');
          const fmv = String(pos.current_value ?? '0');

          investedByInvestorId.set(
            pos.holder_investor_id,
            flAdd(investedByInvestorId.get(pos.holder_investor_id) ?? '0', invested),
          );
          realizedByInvestorId.set(
            pos.holder_investor_id,
            flAdd(realizedByInvestorId.get(pos.holder_investor_id) ?? '0', realized),
          );
          fmvByInvestorId.set(
            pos.holder_investor_id,
            flAdd(fmvByInvestorId.get(pos.holder_investor_id) ?? '0', fmv),
          );
        }
      }

      let out = `**Investors / LPs (${investors.length}):**\n\n`;
      out += `| Investor | Type | Invested | Realized | FMV | DPI | MOIC | IRR |\n`;
      out += `| --- | --- | --- | --- | --- | --- | --- | --- |\n`;
      for (const inv of investors) {
        const invested = investedByInvestorId.get(inv.id) ?? '0';
        const realized = realizedByInvestorId.get(inv.id) ?? '0';
        const fmv = fmvByInvestorId.get(inv.id) ?? '0';
        const hasInvested = flIsPositive(invested);
        const dpi = hasInvested ? flDiv(realized, invested, 2) : null;
        const moic = hasInvested ? flDiv(flAdd(fmv, realized), invested, 2) : null;
        const irr = null;

        out += `| ${inv.name} | ${inv.investor_type ?? "-"} | ${fmtAmount(
          invested,
        )} | ${fmtAmount(realized)} | ${fmtAmount(
          fmv,
        )} | ${fmtMult(dpi)} | ${fmtMult(moic)} | ${fmtPct(irr)} |\n`;
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
