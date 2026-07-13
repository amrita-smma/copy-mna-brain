import type {
  FundAssetRepository,
  FundAssetTransactionRepository,
  FundAssetValuationRepository,
  FundRepository,
  Tables,
} from '@/lib/repositories';

export interface PortfolioAsset {
  asset: Tables<'fund_assets'>;
  txns: Tables<'fund_asset_transactions'>[];
  valuations: Tables<'fund_asset_valuations'>[];
}

/** A fund row with its assets' full ledgers already attached — everything the
 *  Fund Management view needs to build one fund, with no per-asset round trip. */
export type PortfolioFund = Tables<'funds'> & { assets: PortfolioAsset[] };

/** The synthetic fund the view shows for assets not attached to any real fund
 *  — kept in sync with the same pseudo-fund GET /api/funds injects. */
function unassignedFundRow(workspaceId: string): Tables<'funds'> {
  const now = new Date().toISOString();
  return {
    id: 'unassigned',
    workspace_id: workspaceId,
    name: 'Unassigned Assets',
    description: 'Assets without a fund assignment',
    vintage_year: null,
    commitment_size_amount: 0,
    base_currency: 'USD',
    status: 'active',
    called_amount: 0,
    fmv_amount: 0,
    realized_amount: 0,
    dpi: 0,
    tvpi: 0,
    irr: 0,
    metrics_computed_at: null,
    created_by: null,
    updated_by: null,
    created_at: now,
    updated_at: now,
  } as unknown as Tables<'funds'>;
}

function groupByAssetId<T extends { fund_asset_id: string }>(rows: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.fund_asset_id);
    if (list) list.push(row);
    else map.set(row.fund_asset_id, [row]);
  }
  return map;
}

/**
 * Assembles the whole Fund Management portfolio — every fund with its assets
 * and each asset's full transaction and valuation ledger — in a fixed handful
 * of batched queries, regardless of how many funds or assets exist.
 *
 * This replaces the view's previous per-asset fan-out (one HTTP request →
 * one DB connection per asset for transactions AND valuations), which under
 * even light concurrency exhausted the Postgres connection pool.
 */
export class FundPortfolioService {
  constructor(
    private readonly fundRepo: FundRepository,
    private readonly fundAssetRepo: FundAssetRepository,
    private readonly transactionRepo: FundAssetTransactionRepository,
    private readonly valuationRepo: FundAssetValuationRepository,
    private readonly workspaceId: string,
  ) {}

  async getPortfolio(): Promise<PortfolioFund[]> {
    const funds = await this.fundRepo.findAll();

    const [assetPairs, unassignedAssets] = await Promise.all([
      this.fundAssetRepo.findByFundIds(funds.map((f) => f.id)),
      this.fundAssetRepo.findUnassignedAssets(),
    ]);

    const assetIds = [
      ...new Set([
        ...assetPairs.map((p) => p.asset.id),
        ...unassignedAssets.map((a) => a.id),
      ]),
    ];

    const [txns, valuations] = await Promise.all([
      this.transactionRepo.findByFundAssetIds(assetIds),
      this.valuationRepo.findByFundAssetIds(assetIds),
    ]);

    const txnsByAsset = groupByAssetId(txns);
    const valsByAsset = groupByAssetId(valuations);

    const toPortfolioAsset = (asset: Tables<'fund_assets'>): PortfolioAsset => ({
      asset,
      txns: txnsByAsset.get(asset.id) ?? [],
      valuations: valsByAsset.get(asset.id) ?? [],
    });

    const assetsByFund = new Map<string, PortfolioAsset[]>();
    for (const { fundId, asset } of assetPairs) {
      const list = assetsByFund.get(fundId);
      if (list) list.push(toPortfolioAsset(asset));
      else assetsByFund.set(fundId, [toPortfolioAsset(asset)]);
    }

    const result: PortfolioFund[] = funds.map((fund) => ({
      ...fund,
      assets: assetsByFund.get(fund.id) ?? [],
    }));

    if (unassignedAssets.length > 0) {
      result.push({
        ...unassignedFundRow(this.workspaceId),
        assets: unassignedAssets.map(toPortfolioAsset),
      });
    }

    return result;
  }
}
