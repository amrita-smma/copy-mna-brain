import type {
  FundAssetTransactionRepository,
  FundAssetValuationRepository,
  Tables,
  TablesInsert,
  TablesUpdate,
} from '@/lib/repositories';
import type { FundMetricsService } from './fundMetricsService';

export class LastTransactionDeleteError extends Error {
  constructor(assetId: string) {
    super(
      `Cannot delete the last remaining transaction for asset ${assetId} — a position must have at least one transaction`,
    );
    this.name = 'LastTransactionDeleteError';
  }
}

export class TransactionNotFoundError extends Error {
  constructor(id: string) {
    super(`Transaction ${id} not found`);
    this.name = 'TransactionNotFoundError';
  }
}

export class ValuationNotFoundError extends Error {
  constructor(id: string) {
    super(`Valuation ${id} not found`);
    this.name = 'ValuationNotFoundError';
  }
}

export class FundAssetLedgerService {
  constructor(
    private readonly transactionRepo: FundAssetTransactionRepository,
    private readonly valuationRepo: FundAssetValuationRepository,
    private readonly fundMetricsService: FundMetricsService,
  ) {}

  listTransactions(assetId: string): Promise<Tables<'fund_asset_transactions'>[]> {
    return this.transactionRepo.findByFundAssetId(assetId);
  }

  async addTransaction(
    assetId: string,
    data: Omit<TablesInsert<'fund_asset_transactions'>, 'fund_asset_id'>,
  ): Promise<Tables<'fund_asset_transactions'>> {
    const txn = await this.transactionRepo.insert({ ...data, fund_asset_id: assetId });
    await this.fundMetricsService.recomputeAsset(assetId, true);
    return txn;
  }

  async updateTransaction(
    assetId: string,
    id: string,
    updates: TablesUpdate<'fund_asset_transactions'>,
  ): Promise<Tables<'fund_asset_transactions'>> {
    const existing = await this.transactionRepo.findById(id);
    if (!existing || existing.fund_asset_id !== assetId) throw new TransactionNotFoundError(id);
    const row = await this.transactionRepo.update(id, updates);
    if (!row) throw new TransactionNotFoundError(id);
    await this.fundMetricsService.recomputeAsset(assetId, true);
    return row;
  }

  /** Guards against deleting an asset's last remaining transaction (a position must have at least one). */
  async deleteTransaction(assetId: string, id: string): Promise<void> {
    const existing = await this.transactionRepo.findByFundAssetId(assetId);
    if (!existing.some((t) => t.id === id)) throw new TransactionNotFoundError(id);
    if (existing.length <= 1) {
      throw new LastTransactionDeleteError(assetId);
    }
    await this.transactionRepo.delete(id);
    await this.fundMetricsService.recomputeAsset(assetId, true);
  }

  listValuations(assetId: string): Promise<Tables<'fund_asset_valuations'>[]> {
    return this.valuationRepo.findByFundAssetId(assetId);
  }

  async upsertValuation(
    assetId: string,
    data: Omit<TablesInsert<'fund_asset_valuations'>, 'fund_asset_id'>,
  ): Promise<Tables<'fund_asset_valuations'>> {
    const valuation = await this.valuationRepo.upsert({ ...data, fund_asset_id: assetId });
    await this.fundMetricsService.recomputeAsset(assetId, true);
    return valuation;
  }

  async deleteValuation(assetId: string, id: string): Promise<void> {
    const existing = await this.valuationRepo.findById(id);
    if (!existing || existing.fund_asset_id !== assetId) throw new ValuationNotFoundError(id);
    await this.valuationRepo.delete(id);
    await this.fundMetricsService.recomputeAsset(assetId, true);
  }
}
