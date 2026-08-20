import type {
  FundAssetRepository,
  FundAssetTransactionRepository,
  FundAssetValuationRepository,
  FundRepository,
  Tables,
} from '@/lib/repositories';

const SHARE_ACQUIRING_TXN_TYPES = new Set(['contribution']);
const SHARE_DISPOSING_TXN_TYPES = new Set(['divestment']);
const REALIZED_TXN_TYPES = new Set([
  'divestment',
  'interest_income',
  'return_of_capital',
  'other',
]);

interface AssetMetrics {
  shareCount: number;
  investedCapitalAmount: number;
  netDistributionAmount: number;
  unrealizedValueAmount: number;
  totalValueGrossAmount: number;
  dpi: number;
  grossMoic: number;
  grossIrr: number;
  earliestTxnDate: string | null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function yearsSince(dateStr: string): number {
  const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
  return (Date.now() - new Date(dateStr).getTime()) / msPerYear;
}

function earliestDate(dates: Array<string | null | undefined>): string | null {
  const known = dates.filter((d): d is string => Boolean(d));
  if (known.length === 0) return null;
  return known.reduce((earliest, d) => (d < earliest ? d : earliest));
}

/**
 * Recomputes the read-only rollup columns on fund_assets/funds (§2, §6 of the
 * Fund Management schema doc) directly from the transaction ledger and
 * latest valuation, synchronously in-request — no background job for this
 * pass, since per-asset transaction volume is small.
 *
 * Two documented simplifications, matching gaps already called out in the
 * schema doc rather than new ones introduced here:
 * - No independent daily FX rate table exists (Open Question §10.1), so
 *   cross-currency unrealized value uses the asset's most recent
 *   transaction fx_rate as a best-effort spot proxy.
 * - IRR uses the same simplified CAGR approximation as the source mockup's
 *   prototype (`Math.pow(totalValue / invested, 1 / holdYrs) - 1`), not a
 *   true dated-cashflow XIRR.
 */
export class FundMetricsService {
  constructor(
    private readonly fundRepo: FundRepository,
    private readonly fundAssetRepo: FundAssetRepository,
    private readonly transactionRepo: FundAssetTransactionRepository,
    private readonly valuationRepo: FundAssetValuationRepository,
  ) {}

  /** Recompute one asset's rollup columns and write them back, then roll up its fund. */
  async recomputeAsset(assetId: string, clearManualOverrides = false): Promise<void> {
    const asset = await this.fundAssetRepo.findById(assetId);
    if (!asset) return;

    if (clearManualOverrides && asset.is_manually_overridden) {
      asset.is_manually_overridden = false;
      await this.fundAssetRepo.update(assetId, { is_manually_overridden: false });
    }

    // Fetch the ledger once and reuse it for both the metric calculation and
    // the affected-fund lookup below (previously two separate reads).
    const [transactions, latestValuation] = await Promise.all([
      this.transactionRepo.findByFundAssetId(asset.id),
      this.valuationRepo.findLatestByFundAssetId(asset.id),
    ]);
    const metrics = this.computeMetricsFromLedger(asset, transactions, latestValuation);
    await this.fundAssetRepo.update(assetId, {
      share_count: metrics.shareCount,
      invested_capital_amount: metrics.investedCapitalAmount,
      net_distribution_amount: metrics.netDistributionAmount,
      fmv_amount: metrics.unrealizedValueAmount,
      gross_moic: metrics.grossMoic,
      gross_irr: metrics.grossIrr,
      dpi: metrics.dpi,
      metrics_computed_at: new Date().toISOString(),
    });

    const fundIds = new Set(transactions.map((t) => t.fund_id).filter((id): id is string => Boolean(id)));
    for (const fundId of fundIds) {
      await this.recomputeFund(fundId);
    }
  }

  /** Recompute a fund's own rollup columns by summing across all of its assets. */
  async recomputeFund(fundId: string): Promise<void> {
    const assets = await this.fundAssetRepo.findByFundId(fundId);
    const assetIds = assets.map((asset) => asset.id);

    // Batch the whole fund's ledger in two queries instead of firing one
    // transaction query (plus a valuation query) per asset — the old per-asset
    // Promise.all was a server-side N+1.
    const [allTxns, allValuations] = await Promise.all([
      this.transactionRepo.findByFundAssetIds(assetIds),
      this.valuationRepo.findByFundAssetIds(assetIds),
    ]);
    const txnsByAsset = new Map<string, Tables<'fund_asset_transactions'>[]>();
    for (const txn of allTxns) {
      const list = txnsByAsset.get(txn.fund_asset_id);
      if (list) list.push(txn);
      else txnsByAsset.set(txn.fund_asset_id, [txn]);
    }
    // findByFundAssetIds orders valuations newest-first within each asset, so
    // the first one seen per asset is its latest snapshot.
    const latestValuationByAsset = new Map<string, Tables<'fund_asset_valuations'>>();
    for (const valuation of allValuations) {
      if (!latestValuationByAsset.has(valuation.fund_asset_id)) {
        latestValuationByAsset.set(valuation.fund_asset_id, valuation);
      }
    }
    const perAsset = assets.map((asset) =>
      this.computeMetricsFromLedger(
        asset,
        txnsByAsset.get(asset.id) ?? [],
        latestValuationByAsset.get(asset.id),
      ),
    );

    const calledAmount = sum(perAsset.map((m) => m.investedCapitalAmount));
    const fmvAmount = sum(perAsset.map((m) => m.unrealizedValueAmount));

    let realizedAmount = 0;
    for (const txn of allTxns) {
      if (txn.fund_id !== fundId) continue;
      // Skip retained divestments: they were kept as cash in fund, not distributed to LPs
      if (txn.txn_type === 'divestment' && txn.sell_proceeds_destination === 'cash_in_fund') {
        continue;
      }
      if (REALIZED_TXN_TYPES.has(txn.txn_type)) {
        const amount =
          txn.value_amount ??
          (txn.price_per_share != null && txn.share_count != null
            ? txn.price_per_share * txn.share_count
            : 0);
        const converted = amount * (txn.fx_rate ?? 1);
        realizedAmount += converted;
      }
    }

    const totalValue = realizedAmount + fmvAmount;
    const dpi = calledAmount ? realizedAmount / calledAmount : 0;
    const tvpi = calledAmount ? totalValue / calledAmount : 0;

    const holdYrs = earliestDate(perAsset.map((m) => m.earliestTxnDate));
    const irr =
      calledAmount && holdYrs
        ? Math.pow(totalValue / calledAmount, 1 / Math.max(yearsSince(holdYrs), 0.5)) - 1
        : 0;

    await this.fundRepo.update(fundId, {
      called_amount: calledAmount,
      fmv_amount: fmvAmount,
      realized_amount: realizedAmount,
      dpi,
      tvpi,
      irr,
      metrics_computed_at: new Date().toISOString(),
    });
  }

  /**
   * Pure per-asset rollup from an already-fetched ledger — takes the asset's
   * transactions and its latest valuation snapshot rather than querying, so
   * callers can batch the reads (see recomputeFund) instead of issuing a
   * query per asset.
   */
  private computeMetricsFromLedger(
    asset: Tables<'fund_assets'>,
    transactions: Tables<'fund_asset_transactions'>[],
    latestValuation: Tables<'fund_asset_valuations'> | undefined,
  ): AssetMetrics {
    let investedCapitalAmount = 0;
    let netDistributionAmount = 0;
    let sharesAcquired = 0;
    let sharesDisposed = 0;
    let latestFxRate: number | null = null;
    let earliestTxnDate: string | null = null;

    for (const txn of transactions) {
      const amount =
        txn.value_amount ??
        (txn.price_per_share != null && txn.share_count != null
          ? txn.price_per_share * txn.share_count
          : 0);
      const converted = amount * (txn.fx_rate ?? 1);

      if (SHARE_ACQUIRING_TXN_TYPES.has(txn.txn_type)) {
        investedCapitalAmount += converted;
        sharesAcquired += txn.share_count ?? 0;
      }
      if (REALIZED_TXN_TYPES.has(txn.txn_type)) {
        netDistributionAmount += converted;
      }
      if (SHARE_DISPOSING_TXN_TYPES.has(txn.txn_type)) {
        sharesDisposed += txn.share_count ?? 0;
      }
      if (txn.fx_rate != null) latestFxRate = txn.fx_rate;
      if (!earliestTxnDate || txn.txn_date < earliestTxnDate) earliestTxnDate = txn.txn_date;
    }

    const shareCount = sharesAcquired - sharesDisposed;

    let unrealizedValueAmount = 0;
    if (shareCount > 0 && asset.current_price_per_share != null) {
      const spotFactor =
        asset.investment_currency === asset.report_currency ? 1 : (latestFxRate ?? 1);
      unrealizedValueAmount = shareCount * asset.current_price_per_share * spotFactor;
    } else if (asset.asset_type === 'cash') {
      const baseAmount = latestValuation?.market_value_amount ?? 0;
      const asOfDate = latestValuation?.as_of_date ?? null;
      let netPostValuationInflows = 0;

      for (const txn of transactions) {
        if (asOfDate && txn.txn_date <= asOfDate) {
          continue;
        }
        const amount =
          txn.value_amount ??
          (txn.price_per_share != null && txn.share_count != null
            ? txn.price_per_share * txn.share_count
            : 0);
        const converted = amount * (txn.fx_rate ?? 1);

        if (
          txn.txn_type === 'contribution' ||
          txn.txn_type === 'internal_transfer' ||
          txn.txn_type === 'interest_income'
        ) {
          netPostValuationInflows += converted;
        } else if (
          txn.txn_type === 'divestment' ||
          txn.txn_type === 'return_of_capital'
        ) {
          netPostValuationInflows -= converted;
        } else if (txn.txn_type === 'other') {
          netPostValuationInflows += converted;
        }
      }

      unrealizedValueAmount = Math.max(0, baseAmount + netPostValuationInflows);
    } else {
      unrealizedValueAmount = latestValuation?.market_value_amount ?? 0;
    }

    const totalValueGrossAmount = netDistributionAmount + unrealizedValueAmount;
    const dpi = investedCapitalAmount ? netDistributionAmount / investedCapitalAmount : 0;
    const grossMoic = investedCapitalAmount ? totalValueGrossAmount / investedCapitalAmount : 0;
    const holdYrs = earliestTxnDate ?? asset.entry_date;
    const grossIrr =
      investedCapitalAmount && holdYrs
        ? Math.pow(totalValueGrossAmount / investedCapitalAmount, 1 / Math.max(yearsSince(holdYrs), 0.5)) - 1
        : 0;

    if (asset.is_manually_overridden) {
      return {
        shareCount: asset.share_count ?? 0,
        investedCapitalAmount: asset.invested_capital_amount ?? 0,
        netDistributionAmount: asset.net_distribution_amount ?? 0,
        unrealizedValueAmount: asset.fmv_amount ?? 0,
        totalValueGrossAmount: (asset.net_distribution_amount ?? 0) + (asset.fmv_amount ?? 0),
        dpi: asset.dpi ?? 0,
        grossMoic: asset.gross_moic ?? 0,
        grossIrr: asset.gross_irr ?? 0,
        earliestTxnDate: asset.entry_date ?? null,
      };
    }

    return {
      shareCount,
      investedCapitalAmount,
      netDistributionAmount,
      unrealizedValueAmount,
      totalValueGrossAmount,
      dpi,
      grossMoic,
      grossIrr,
      earliestTxnDate,
    };
  }
}
