import type {
  DbClient,
  FlAssetRepository,
  FlFundRepository,
  FlPositionRepository,
  Tables,
} from '@/lib/repositories';
import {
  catalogItemsToCheck,
  compareCatalogToLedger,
  type CatalogCheckInputs,
  type CatalogLedgerCheckResult,
  type FundLedgerTotals,
} from '@/lib/fund_updates/catalogLedgerCheck';
import type { FundCatalogItem } from '@/lib/fund_updates/types';
import { computeFundCashSummary } from '@/lib/fundLedger/fundCashSummary';
import { isFundLpPosition } from '@/lib/fundLedger/lpPositions';
import { normalizeCanonicalName } from '@/lib/fundLedger/normalizeIdentity';
import type { FlBalanceService, PositionBalances } from './flBalanceService';
import { queryAll } from '@/lib/server/queryAll';

// The Nanjing summary sheet is stated in CNY.
const CATALOG_CURRENCY = 'CNY';

/**
 * Reads each catalog fund's ledger totals (commitments, paid-in, invested, cash)
 * in a fixed number of batched queries and compares them with the submitted
 * rows and `基金汇总`.
 */
export class FundCatalogCheckService {
  constructor(
    private readonly workspaceId: string,
    private readonly fundRepo: FlFundRepository,
    private readonly positionRepo: FlPositionRepository,
    private readonly assetRepo: FlAssetRepository,
    private readonly balanceService: FlBalanceService,
  ) {}

  async checkAgainstCatalog(
    catalogItems: FundCatalogItem[] | undefined,
    inputs: CatalogCheckInputs = {},
    executor?: DbClient,
  ): Promise<CatalogLedgerCheckResult> {
    const items = catalogItemsToCheck(catalogItems);
    if (items.length === 0) return compareCatalogToLedger([], new Map());

    const wanted = new Set(items.map((i) => normalizeCanonicalName(i.nameZh)));
    const funds = (await this.fundRepo.findByWorkspaceId(this.workspaceId, executor)).filter((f) =>
      wanted.has(normalizeCanonicalName(f.name)),
    );
    const fundIds = funds.map((f) => f.id);

    const [lpCandidates, holdings] = await queryAll(executor, [
      () => this.positionRepo.findByFundIds(this.workspaceId, fundIds, executor),
      () => this.positionRepo.findByHolderFundIds(this.workspaceId, fundIds, executor),
    ]);
    const positionIds = [...new Set([...lpCandidates, ...holdings].map((p) => p.id))];
    const assetIds = [
      ...new Set(holdings.map((p) => p.asset_id).filter((id): id is string => Boolean(id))),
    ];
    const [balances, assets] = await queryAll(executor, [
      () => this.balanceService.getPositionBalances(this.workspaceId, positionIds, null, executor),
      () => this.assetRepo.findByIds(this.workspaceId, assetIds, executor),
    ]);

    const balanceById = new Map(balances.map((b) => [b.position_id, b]));
    const assetById = new Map(assets.map((a) => [a.id, a]));
    const lpsByFund = groupBy(lpCandidates, (p) => p.fund_id);
    const holdingsByFund = groupBy(holdings, (p) => p.holder_fund_id);

    const totals = new Map<string, FundLedgerTotals>();
    for (const fund of funds) {
      totals.set(
        normalizeCanonicalName(fund.name),
        fundTotals(
          fund,
          lpsByFund.get(fund.id) ?? [],
          holdingsByFund.get(fund.id) ?? [],
          balanceById,
          assetById,
        ),
      );
    }

    return compareCatalogToLedger(items, totals, inputs);
  }
}

function groupBy<T>(rows: T[], keyOf: (row: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const list = out.get(key);
    if (list) list.push(row);
    else out.set(key, [row]);
  }
  return out;
}

function fundTotals(
  fund: Tables<'fl_funds'>,
  lpCandidates: Tables<'fl_positions'>[],
  holdings: Tables<'fl_positions'>[],
  balanceById: Map<string, PositionBalances>,
  assetById: Map<string, Tables<'fl_assets'>>,
): FundLedgerTotals {
  const num = (value: string | undefined) => Number(value ?? 0);

  let committed = 0;
  let paidIn = 0;
  let paidInAdjustment = 0;
  for (const position of lpCandidates) {
    if (!isFundLpPosition(position, fund)) continue;
    const balance = balanceById.get(position.id);
    committed += num(balance?.committed);
    paidIn += num(balance?.contributed);
    paidInAdjustment += num(balance?.paid_in_adjustment);
  }

  const enriched = holdings.map((p) => ({
    ...p,
    asset: p.asset_id ? assetById.get(p.asset_id) : undefined,
  }));
  const isCash = (p: (typeof enriched)[number]) =>
    p.asset?.asset_kind === 'cash' || balanceById.get(p.id)?.asset_kind === 'cash';

  let invested = 0;
  for (const position of enriched) {
    if (isCash(position)) continue;
    invested += num(balanceById.get(position.id)?.contributed);
  }

  const cashSummary = computeFundCashSummary({
    fund,
    positions: enriched,
    balances: balanceById,
  });
  const cash = num(
    cashSummary.cash_balances.find((b) => b.currency === CATALOG_CURRENCY)?.amount,
  );

  return { committed, paidIn, paidInCash: paidIn - paidInAdjustment, invested, cash };
}
