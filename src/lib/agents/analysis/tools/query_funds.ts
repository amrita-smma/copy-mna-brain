import { tool } from "@langchain/core/tools";
import { getActiveWorkspaceId } from "@/lib/workspace";
import { z } from "zod";
import { createDb } from "@/lib/server/db";
import { computeFundCashSummary, type FundCashSummary } from "@/lib/fundLedger/fundCashSummary";
import { FlInvestorRepository, type Tables } from "@/lib/repositories";
import { flAdd, flDiv, flIsPositive, toDecimalString } from "@/lib/services/flDecimal";
import { isFundLpPosition } from "@/lib/fundLedger/lpPositions";
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
 * List the workspace's funds with their headline metrics for the investment
 * Copilot using Fund Ledger v2 portfolio read model. Read-only; optionally filters by status.
 */
export const queryFunds = tool(
  async ({ status }: { status?: string }) => {
    logger.debug(`🔧 TOOL CALLED: query_funds(status='${status ?? ""}')`);

    try {
      const workspaceId = await getActiveWorkspaceId();
      const db = createDb();
      // Resolved lazily to keep this tool off the container's static import
      // cycle (see TECH_DEBT.md "Runtime import cycle").
      const { createContainer } = await import("@/lib/services/container");
      const { flPortfolioService } = createContainer(db, workspaceId);
      const portfolio = await flPortfolioService.getPortfolio(workspaceId);
      const managedFunds = portfolio.managed_funds ?? [];
      const managedFundIds = new Set(managedFunds.map((f) => f.id));

      // Collect all holding investors across positions
      const holdingInvestorIds = [
        ...new Set(
          (portfolio.positions ?? [])
            .filter((p) => p.holder_investor_id && (p.asset_id || (p.fund_id && !managedFundIds.has(p.fund_id))))
            .map((p) => p.holder_investor_id as string),
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

      interface EntityRow {
        id: string;
        kind: 'fund' | 'investor';
        name: string;
        vintage_year?: number | null;
        status?: string | null;
        base_currency?: string | null;
      }

      let entities: EntityRow[] = [
        ...managedFunds.map((f) => ({
          id: f.id,
          kind: 'fund' as const,
          name: f.name,
          vintage_year: f.vintage_year,
          status: f.status,
          base_currency: f.base_currency,
        })),
        ...holdingInvestorIds.map((id) => {
          const inv = investorById.get(id);
          return {
            id,
            kind: 'investor' as const,
            name: getInvestorDisplayName(id),
            vintage_year: null,
            status: (inv as any)?.status ?? 'active',
            base_currency: 'USD',
          };
        }),
      ];

      if (status) {
        const wanted = status.trim().toLowerCase();
        entities = entities.filter((e) => (e.status ?? "").toLowerCase() === wanted);
      }

      if (entities.length === 0) {
        return status
          ? `No funds found with status "${status}".`
          : "No funds found in this workspace.";
      }

      // Pre-aggregate LP positions (target fund) and portfolio positions (held by fund or investor)
      const commitmentByEntityId = new Map<string, string>();
      const calledByEntityId = new Map<string, string>();
      const fmvByEntityId = new Map<string, string>();
      const valuedEntityIds = new Set<string>();
      const realizedByEntityId = new Map<string, string>();

      for (const pos of portfolio.positions ?? []) {
        // A managed fund's LPs: outside investors and the managed funds holding it.
        if (pos.fund_id && managedFundIds.has(pos.fund_id) && isFundLpPosition(pos, { id: pos.fund_id, managed: true })) {
          const committed = String(pos.balance?.commitment ?? pos.balance?.committed ?? '0');
          const called = String(pos.balance?.drawn_commitment ?? pos.balance?.contributed ?? '0');
          commitmentByEntityId.set(
            pos.fund_id,
            flAdd(commitmentByEntityId.get(pos.fund_id) ?? '0', committed),
          );
          calledByEntityId.set(
            pos.fund_id,
            flAdd(calledByEntityId.get(pos.fund_id) ?? '0', called),
          );
        }

        const holderId =
          pos.holder_fund_id ??
          (pos.holder_investor_id && (pos.asset_id || (pos.fund_id && !managedFundIds.has(pos.fund_id)))
            ? pos.holder_investor_id
            : null);

        if (holderId) {
          const isCash = pos.asset?.asset_kind === 'cash' || pos.balance?.asset_kind === 'cash';
          // Ensure cash positions are never treated as holdings or realized proceeds
          if (!isCash) {
            if (pos.current_value != null) valuedEntityIds.add(holderId);
            const fmv = String(pos.current_value ?? '0');
            const realized = String(pos.balance?.distributed_capital ?? pos.balance?.distributed ?? '0');
            fmvByEntityId.set(
              holderId,
              flAdd(fmvByEntityId.get(holderId) ?? '0', fmv),
            );
            realizedByEntityId.set(
              holderId,
              flAdd(realizedByEntityId.get(holderId) ?? '0', realized),
            );

            if (pos.holder_investor_id === holderId) {
              const committed = String(pos.balance?.commitment ?? pos.balance?.committed ?? '0');
              const called = String(pos.balance?.drawn_commitment ?? pos.balance?.contributed ?? '0');
              if (flIsPositive(committed)) {
                commitmentByEntityId.set(
                  holderId,
                  flAdd(commitmentByEntityId.get(holderId) ?? '0', committed),
                );
              }
              if (flIsPositive(called)) {
                calledByEntityId.set(
                  holderId,
                  flAdd(calledByEntityId.get(holderId) ?? '0', called),
                );
              }
            }
          }
        }
      }

      let out = `**Funds (${entities.length}):**\n\n`;
      out += `| Fund | Vintage | Status | Commitment | Called | FMV | Realized | DPI | TVPI | IRR |\n`;
      out += `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n`;
      for (const entity of entities) {
        const commitment = commitmentByEntityId.get(entity.id) ?? '0';
        const called = calledByEntityId.get(entity.id) ?? '0';
        const holdingsFmv = fmvByEntityId.get(entity.id) ?? '0';
        const realized = realizedByEntityId.get(entity.id) ?? '0';
        const hasCalled = flIsPositive(called);
        const dpi = hasCalled ? flDiv(realized, called, 2) : null;

        const cashSummary =
          entity.kind === 'fund'
            ? portfolio.fund_cash_summaries?.[entity.id]
            : portfolio.fund_cash_summaries?.[entity.id] ??
              computeFundCashSummary({
                holder: { kind: 'investor', id: entity.id, base_currency: entity.base_currency },
                positions: portfolio.positions ?? [],
                entries: portfolio.entries,
                balances: portfolio.balances,
                asOfDate: portfolio.as_of_date,
              });
        // FMV (Unrealized MV) is holdings mark-to-market only — cash never enters it.
        // "-" until at least one holding carries a value.
        const fmvDisplay = valuedEntityIds.has(entity.id) ? fmtAmount(holdingsFmv) : '-';
        // TVPI keeps NAV = holdings + cash, so it is unavailable while cash is pending FX.
        let tvpi: string | null = null;
        let cashDetail = '';

        if (cashSummary?.reporting_total_available && cashSummary.reporting_total !== null) {
          const nav = flAdd(holdingsFmv, cashSummary.reporting_total);
          tvpi = hasCalled ? flDiv(flAdd(nav, realized), called, 2) : null;
        } else if (cashSummary?.fx_status === 'pending_fx') {
          tvpi = null;
        } else {
          tvpi = hasCalled ? flDiv(flAdd(holdingsFmv, realized), called, 2) : null;
        }
        if (cashSummary?.cash_balances && cashSummary.cash_balances.length > 0) {
          cashDetail = ` · Cash: ${cashSummary.cash_balances.map((b) => `${b.currency} ${fmtAmount(b.amount)}`).join(', ')}`;
        }

        const irr = null;

        out += `| ${entity.name}${cashDetail} | ${entity.vintage_year ?? "-"} | ${entity.status ?? "-"} | ${fmtAmount(
          commitment,
        )} | ${fmtAmount(called)} | ${fmvDisplay} | ${fmtAmount(
          realized,
        )} | ${fmtMult(dpi)} | ${fmtMult(tvpi)} | ${fmtPct(irr)} |\n`;
      }
      out += `\nAmounts are in each fund's base currency. FMV is the holdings' unrealized market value only; cash is listed next to the fund name and counts toward TVPI, not FMV. Use query_fund_assets with a fund name to drill into its holdings.`;

      logger.debug(`✓ query_funds returned ${entities.length} fund(s)`);
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
