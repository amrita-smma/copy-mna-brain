import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { z } from "zod";
import { createDb } from "@/lib/server/db";
import { createContainer } from "@/lib/services";
import { FlInvestorRepository, type Tables } from "@/lib/repositories";
import { logger } from "../../logger";
import { fuzzySearch } from "./fuzzySearch";

const fmtAmount = (n: number | string | null | undefined) => {
  if (n == null) return "-";
  const num = typeof n === "string" ? parseFloat(n) : n;
  return !isNaN(num) ? num.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "-";
};
const fmtMult = (n: number | string | null | undefined) => {
  if (n == null) return "-";
  const num = typeof n === "string" ? parseFloat(n) : n;
  return !isNaN(num) ? `${num.toFixed(2)}x` : "-";
};
const fmtPct = (n: number | string | null | undefined) => {
  if (n == null) return "-";
  const num = typeof n === "string" ? parseFloat(n) : n;
  return !isNaN(num) ? `${(num * 100).toFixed(1)}%` : "-";
};

/**
 * List fund assets (holdings) for the investment Copilot using Fund Ledger v2.
 * With no `fund`, lists every asset across all funds (plus any unassigned assets);
 * with a `fund` name it drills into that fund's holdings. Read-only.
 */
export const queryFundAssets = tool(
  async ({ fund, status }: { fund?: string; status?: string }) => {
    logger.debug(`🔧 TOOL CALLED: query_fund_assets(fund='${fund ?? ""}', status='${status ?? ""}')`);

    try {
      const workspaceId = await getActiveWorkspaceId();
      const db = createDb();
      const { flPortfolioService } = createContainer(db, workspaceId);
      const portfolio = await flPortfolioService.getPortfolio(workspaceId);
      const funds = portfolio.managed_funds;

      // Extract and batch lookup all holding investors across positions
      const holdingInvestorIds = [
        ...new Set(
          (portfolio.positions ?? [])
            .map((p) => p.holder_investor_id)
            .filter((id): id is string => Boolean(id)),
        ),
      ];

      const investorRepo = new FlInvestorRepository(db);
      const directInvestors =
        holdingInvestorIds.length > 0
          ? await investorRepo.findByIds(workspaceId, holdingInvestorIds)
          : [];

      const investorById = new Map<string, Tables<'fl_investors'>>();
      for (const inv of directInvestors) {
        investorById.set(inv.id, inv);
      }
      for (const p of portfolio.positions ?? []) {
        if (p.holder_investor && !investorById.has(p.holder_investor.id)) {
          investorById.set(p.holder_investor.id, p.holder_investor);
        }
      }

      const missingParentIds = [
        ...new Set(
          Array.from(investorById.values())
            .map((inv) => inv.parent_investor_id)
            .filter((pid): pid is string => Boolean(pid) && !investorById.has(pid)),
        ),
      ];
      if (missingParentIds.length > 0) {
        const parentInvestors = await investorRepo.findByIds(workspaceId, missingParentIds);
        for (const pinv of parentInvestors) {
          investorById.set(pinv.id, pinv);
        }
      }

      const getInvestorDisplayName = (id: string): string => {
        const inv = investorById.get(id);
        if (!inv) return id;
        if (inv.parent_investor_id) {
          const parent = investorById.get(inv.parent_investor_id);
          const parentName = parent?.name ?? inv.parent_investor_id;
          return `${inv.name} (${parentName})`;
        }
        return inv.name;
      };

      // Resolve which funds or entities to pull assets from
      let targetHolderIds: Set<string> | null = null;
      if (fund) {
        const allHolders = [
          ...funds.map((f) => ({ id: f.id, name: f.name })),
          ...holdingInvestorIds.map((id) => ({ id, name: getInvestorDisplayName(id) })),
        ];
        const matches = fuzzySearch(fund, allHolders, (h) => [h.name]).map((m) => m.item);
        if (matches.length === 0) {
          return (
            `No fund found matching "${fund}". Use query_funds to see available funds, ` +
            `or search_investments to check whether "${fund}" is a holding, investor, or capital source instead.`
          );
        }
        targetHolderIds = new Set(matches.map((h) => h.id));
      }

      const rows: Array<{
        fundName: string;
        assetName: string;
        assetType: string;
        sector: string;
        status: string;
        invested: string | number | null;
        distributed: string | number | null;
        fmv: string | number | null;
        moic: number | null;
        dpi: number | null;
        irr: number | null;
      }> = [];

      const assignedAssetIds = new Set<string>();

      // Read portfolio asset holdings
      for (const pos of portfolio.positions) {
        if (!pos.asset && !pos.fund) continue;
        if (pos.asset?.asset_kind === 'cash' || pos.balance?.asset_kind === 'cash') continue;
        const holderId = pos.holder_fund_id ?? pos.holder_investor_id;
        if (targetHolderIds && (!holderId || !targetHolderIds.has(holderId))) {
          continue;
        }

        let holdingFundName = "-";
        if (pos.holder_fund_id) {
          holdingFundName = pos.holder_fund?.name ?? "-";
        } else if (pos.holder_investor_id) {
          holdingFundName = getInvestorDisplayName(pos.holder_investor_id);
        }
        const assetName = pos.asset?.name ?? pos.fund?.name ?? "-";
        if (pos.asset_id) assignedAssetIds.add(pos.asset_id);

        const assetType = pos.asset?.asset_kind ?? (pos.fund ? "fund_of_funds" : "-");
        const sector = pos.asset?.sector ?? "-";
        const posStatus = pos.status ?? "-";
        const invested = pos.balance?.contributed ?? null;
        const distributed = pos.balance?.distributed ?? null;
        const fmv = pos.current_value ?? null;
        const moic = invested && fmv && parseFloat(invested) > 0 ? parseFloat(fmv) / parseFloat(invested) : null;
        const dpi = invested && distributed && parseFloat(invested) > 0 ? parseFloat(distributed) / parseFloat(invested) : null;
        const irr = null;

        rows.push({
          fundName: holdingFundName,
          assetName,
          assetType,
          sector,
          status: posStatus,
          invested,
          distributed,
          fmv,
          moic,
          dpi,
          irr,
        });
      }

      // If no fund filter specified, fold in unassigned assets
      if (!fund) {
        for (const a of portfolio.assets) {
          if (a.asset_kind === 'cash') continue;
          if (!assignedAssetIds.has(a.id)) {
            rows.push({
              fundName: "(unassigned)",
              assetName: a.name,
              assetType: a.asset_kind ?? "-",
              sector: a.sector ?? "-",
              status: "active",
              invested: null,
              distributed: null,
              fmv: null,
              moic: null,
              dpi: null,
              irr: null,
            });
          }
        }
      }

      let filtered = rows;
      if (status) {
        const wanted = status.trim().toLowerCase();
        filtered = rows.filter((r) => r.status.toLowerCase() === wanted);
      }

      if (filtered.length === 0) {
        return "No fund assets found for the given filters.";
      }

      let out = `**Fund assets (${filtered.length}):**\n\n`;
      out += `| Asset | Fund | Type | Sector | Status | Invested | Distributed | FMV | MOIC | DPI | IRR |\n`;
      out += `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
      for (const r of filtered) {
        out += `| ${r.assetName} | ${r.fundName} | ${r.assetType} | ${r.sector} | ${
          r.status
        } | ${fmtAmount(r.invested)} | ${fmtAmount(
          r.distributed,
        )} | ${fmtAmount(r.fmv)} | ${fmtMult(r.moic)} | ${fmtMult(r.dpi)} | ${fmtPct(
          r.irr,
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
