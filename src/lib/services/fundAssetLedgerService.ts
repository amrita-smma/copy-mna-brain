import type {
  DbClient,
  FundAssetRepository,
  FundAssetTransactionRepository,
  FundAssetValuationRepository,
  FundRepository,
  Tables,
  TablesInsert,
  TablesUpdate,
} from '@/lib/repositories';
import {
  FundAssetRepository as ConcreteFundAssetRepo,
  FundAssetTransactionRepository as ConcreteFundAssetTxnRepo,
  FundAssetValuationRepository as ConcreteFundAssetValuationRepo,
  FundRepository as ConcreteFundRepo,
} from '@/lib/repositories';
import type { FundMetricsService } from './fundMetricsService';
import { isSellProceedsDestination } from '@/lib/sellProceedsDestination';

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

export class InvalidTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransactionError';
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
    private readonly db: DbClient,
    private readonly workspaceId: string,
    private readonly transactionRepo: FundAssetTransactionRepository,
    private readonly valuationRepo: FundAssetValuationRepository,
    private readonly fundAssetRepo: FundAssetRepository,
    private readonly fundRepo: FundRepository,
    private readonly fundMetricsService: FundMetricsService,
  ) {}

  private async runInTransaction<T>(
    fn: (repos: {
      transactionRepo: FundAssetTransactionRepository;
      fundAssetRepo: FundAssetRepository;
      fundRepo: FundRepository;
      valuationRepo: FundAssetValuationRepository;
    }) => Promise<T>,
  ): Promise<T> {
    if (this.db && typeof this.db.transaction === 'function') {
      return this.db.transaction(async (tx) => {
        const txClient = tx as unknown as DbClient;
        const txTransactionRepo = new ConcreteFundAssetTxnRepo(txClient, this.workspaceId);
        const txFundAssetRepo = new ConcreteFundAssetRepo(txClient, this.workspaceId);
        const txFundRepo = new ConcreteFundRepo(txClient, this.workspaceId);
        const txValuationRepo = new ConcreteFundAssetValuationRepo(txClient, this.workspaceId);
        return fn({
          transactionRepo: txTransactionRepo,
          fundAssetRepo: txFundAssetRepo,
          fundRepo: txFundRepo,
          valuationRepo: txValuationRepo,
        });
      });
    }
    return fn({
      transactionRepo: this.transactionRepo,
      fundAssetRepo: this.fundAssetRepo,
      fundRepo: this.fundRepo,
      valuationRepo: this.valuationRepo,
    });
  }

  /**
   * Resolves the cash asset for a given fund and currency.
   * If an existing cash asset is already attributed to this fund for the currency, reuses it.
   * Otherwise creates a fund-specific default cash asset `Cash - ${fundName} (${currency})`.
   * Never falls back to or reuses cash assets across different funds.
   */
  async resolveCashAsset(
    fundId: string,
    currency: string = 'USD',
    repos?: { fundAssetRepo: FundAssetRepository; fundRepo: FundRepository },
  ): Promise<Tables<'fund_assets'>> {
    const fundAssetRepo = repos?.fundAssetRepo ?? this.fundAssetRepo;
    const fundRepo = repos?.fundRepo ?? this.fundRepo;
    const normalizedCurrency = (currency || 'USD').trim().toUpperCase();

    // 1. Look for existing cash assets already attributed to this specific fund
    const fundAssets = await fundAssetRepo.findByFundId(fundId);
    const matchingFundCash = fundAssets.filter((a) => {
      if (a.asset_type !== 'cash') return false;
      const c = (a.investment_currency ?? a.report_currency ?? 'USD').toUpperCase();
      return c === normalizedCurrency;
    });

    if (matchingFundCash.length === 1) {
      return matchingFundCash[0];
    }

    if (matchingFundCash.length > 1) {
      const fund = await fundRepo.findById(fundId);
      const expectedName = fund?.name
        ? `Cash - ${fund.name} (${normalizedCurrency})`
        : `Cash - ${fundId} (${normalizedCurrency})`;
      const defaultMatch = matchingFundCash.find(
        (a) => (a.asset_name ?? '').trim().toLowerCase() === expectedName.toLowerCase(),
      );
      if (defaultMatch) return defaultMatch;
      return matchingFundCash[0];
    }

    // 2. No existing cash asset attributed to this fund — generate a fund-specific cash asset
    const fund = await fundRepo.findById(fundId);
    const defaultName = fund?.name
      ? `Cash - ${fund.name} (${normalizedCurrency})`
      : `Cash - ${fundId} (${normalizedCurrency})`;

    return fundAssetRepo.insert({
      asset_type: 'cash',
      asset_name: defaultName,
      investment_currency: normalizedCurrency,
      report_currency: normalizedCurrency,
      status: 'active',
      type_details: {},
    });
  }

  listTransactions(assetId: string): Promise<Tables<'fund_asset_transactions'>[]> {
    return this.transactionRepo.findByFundAssetId(assetId);
  }

  async addTransaction(
    assetId: string,
    data: Omit<TablesInsert<'fund_asset_transactions'>, 'fund_asset_id'>,
  ): Promise<Tables<'fund_asset_transactions'>> {
    if (data.txn_type === 'internal_transfer') {
      throw new InvalidTransactionError('internal_transfer transactions cannot be created directly');
    }
    if ((data as TablesInsert<'fund_asset_transactions'>).source_divestment_txn_id) {
      throw new InvalidTransactionError('source_divestment_txn_id cannot be set manually');
    }

    let sellProceedsDestination = data.sell_proceeds_destination ?? null;
    if (data.txn_type === 'divestment') {
      if (!sellProceedsDestination) {
        throw new InvalidTransactionError(
          'sell_proceeds_destination is required for divestment transactions',
        );
      }
      if (!isSellProceedsDestination(sellProceedsDestination)) {
        throw new InvalidTransactionError(
          'Invalid sell_proceeds_destination: must be cash_in_fund or distributed_to_investor',
        );
      }
      if (sellProceedsDestination === 'cash_in_fund' && !data.fund_id) {
        throw new InvalidTransactionError(
          'fund_id is required when sell_proceeds_destination is cash_in_fund',
        );
      }
    } else {
      sellProceedsDestination = null;
    }

    let createdTxn!: Tables<'fund_asset_transactions'>;
    let linkedCashAssetId: string | null = null;

    await this.runInTransaction(async (repos) => {
      createdTxn = await repos.transactionRepo.insert({
        ...data,
        fund_asset_id: assetId,
        sell_proceeds_destination: sellProceedsDestination,
      });

      if (
        createdTxn.txn_type === 'divestment' &&
        createdTxn.sell_proceeds_destination === 'cash_in_fund' &&
        createdTxn.fund_id
      ) {
        const cashAsset = await this.resolveCashAsset(
          createdTxn.fund_id,
          createdTxn.txn_currency ?? 'USD',
          repos,
        );
        if (cashAsset.id === assetId) {
          throw new InvalidTransactionError(
            'cash_in_fund is not valid for a cash asset: proceeds would transfer to the same asset',
          );
        }
        linkedCashAssetId = cashAsset.id;
        const amount =
          createdTxn.value_amount ??
          (createdTxn.price_per_share != null && createdTxn.share_count != null
            ? createdTxn.price_per_share * createdTxn.share_count
            : 0);

        await repos.transactionRepo.upsertLinkedCashMovement({
          fund_asset_id: cashAsset.id,
          fund_id: createdTxn.fund_id,
          holding_entity_id: createdTxn.holding_entity_id ?? null,
          funding_source_id: createdTxn.funding_source_id ?? null,
          txn_date: createdTxn.txn_date,
          txn_type: 'internal_transfer',
          sub_type_label: 'Retained sale proceeds',
          value_amount: amount,
          txn_currency: createdTxn.txn_currency ?? 'USD',
          fx_rate: createdTxn.fx_rate ?? 1,
          sell_proceeds_destination: null,
          source_divestment_txn_id: createdTxn.id,
          notes: createdTxn.notes
            ? `Retained proceeds from divestment: ${createdTxn.notes}`
            : 'Retained proceeds from divestment',
        });
      }
    });

    await this.fundMetricsService.recomputeAsset(assetId, true);
    if (linkedCashAssetId) {
      await this.fundMetricsService.recomputeAsset(linkedCashAssetId, true);
    }

    return createdTxn;
  }

  async updateTransaction(
    assetId: string,
    id: string,
    updates: TablesUpdate<'fund_asset_transactions'>,
  ): Promise<Tables<'fund_asset_transactions'>> {
    const existing = await this.transactionRepo.findById(id);
    if (!existing || existing.fund_asset_id !== assetId) throw new TransactionNotFoundError(id);

    if (existing.txn_type === 'internal_transfer') {
      throw new InvalidTransactionError(
        'Generated internal_transfer transactions cannot be edited directly',
      );
    }
    if (updates.txn_type === 'internal_transfer') {
      throw new InvalidTransactionError(
        'Transactions cannot be converted to internal_transfer',
      );
    }
    if ((updates as TablesUpdate<'fund_asset_transactions'>).source_divestment_txn_id !== undefined) {
      throw new InvalidTransactionError('source_divestment_txn_id cannot be modified directly');
    }

    const finalTxnType = updates.txn_type !== undefined ? updates.txn_type : existing.txn_type;
    let finalSellProceedsDestination =
      updates.sell_proceeds_destination !== undefined
        ? updates.sell_proceeds_destination
        : existing.sell_proceeds_destination;
    const finalFundId = updates.fund_id !== undefined ? updates.fund_id : existing.fund_id;

    if (finalTxnType === 'divestment') {
      if (!finalSellProceedsDestination) {
        throw new InvalidTransactionError(
          'sell_proceeds_destination is required for divestment transactions',
        );
      }
      if (!isSellProceedsDestination(finalSellProceedsDestination)) {
        throw new InvalidTransactionError(
          'Invalid sell_proceeds_destination: must be cash_in_fund or distributed_to_investor',
        );
      }
      if (finalSellProceedsDestination === 'cash_in_fund' && !finalFundId) {
        throw new InvalidTransactionError(
          'fund_id is required when sell_proceeds_destination is cash_in_fund',
        );
      }
    } else {
      finalSellProceedsDestination = null;
    }

    let updatedTxn!: Tables<'fund_asset_transactions'>;
    let newCashAssetId: string | null = null;
    let oldCashAssetId: string | null = null;
    const oldFundId = existing.fund_id;

    await this.runInTransaction(async (repos) => {
      const existingMovement = await repos.transactionRepo.findBySourceDivestmentTxnId(id);
      if (existingMovement) {
        oldCashAssetId = existingMovement.fund_asset_id;
      }

      const row = await repos.transactionRepo.update(id, {
        ...updates,
        sell_proceeds_destination: finalSellProceedsDestination,
      });
      if (!row) throw new TransactionNotFoundError(id);
      updatedTxn = row;

      if (
        finalTxnType === 'divestment' &&
        finalSellProceedsDestination === 'cash_in_fund' &&
        finalFundId
      ) {
        const cashAsset = await this.resolveCashAsset(
          finalFundId,
          updatedTxn.txn_currency ?? 'USD',
          repos,
        );
        if (cashAsset.id === assetId) {
          throw new InvalidTransactionError(
            'cash_in_fund is not valid for a cash asset: proceeds would transfer to the same asset',
          );
        }
        newCashAssetId = cashAsset.id;
        const amount =
          updatedTxn.value_amount ??
          (updatedTxn.price_per_share != null && updatedTxn.share_count != null
            ? updatedTxn.price_per_share * updatedTxn.share_count
            : 0);

        await repos.transactionRepo.upsertLinkedCashMovement({
          fund_asset_id: cashAsset.id,
          fund_id: finalFundId,
          holding_entity_id: updatedTxn.holding_entity_id ?? null,
          funding_source_id: updatedTxn.funding_source_id ?? null,
          txn_date: updatedTxn.txn_date,
          txn_type: 'internal_transfer',
          sub_type_label: 'Retained sale proceeds',
          value_amount: amount,
          txn_currency: updatedTxn.txn_currency ?? 'USD',
          fx_rate: updatedTxn.fx_rate ?? 1,
          sell_proceeds_destination: null,
          source_divestment_txn_id: updatedTxn.id,
          notes: updatedTxn.notes
            ? `Retained proceeds from divestment: ${updatedTxn.notes}`
            : 'Retained proceeds from divestment',
        });
      } else if (existingMovement) {
        await repos.transactionRepo.deleteBySourceDivestmentTxnId(id);
      }
    });

    await this.fundMetricsService.recomputeAsset(assetId, true);
    if (newCashAssetId) {
      await this.fundMetricsService.recomputeAsset(newCashAssetId, true);
    }
    if (oldCashAssetId && oldCashAssetId !== newCashAssetId) {
      await this.fundMetricsService.recomputeAsset(oldCashAssetId, true);
    }
    if (oldFundId && oldFundId !== finalFundId) {
      await this.fundMetricsService.recomputeFund(oldFundId);
    }

    return updatedTxn;
  }

  /** Guards against deleting an asset's last remaining transaction (a position must have at least one). */
  async deleteTransaction(assetId: string, id: string): Promise<void> {
    const existing = await this.transactionRepo.findByFundAssetId(assetId);
    const txnToDelete = existing.find((t) => t.id === id);
    if (!txnToDelete) throw new TransactionNotFoundError(id);

    if (txnToDelete.txn_type === 'internal_transfer') {
      throw new InvalidTransactionError(
        'Generated internal_transfer transactions cannot be deleted directly',
      );
    }
    if (existing.length <= 1) {
      throw new LastTransactionDeleteError(assetId);
    }

    let linkedCashAssetId: string | null = null;
    const deletedFundId = txnToDelete.fund_id;

    await this.runInTransaction(async (repos) => {
      const linkedMovement = await repos.transactionRepo.findBySourceDivestmentTxnId(id);
      if (linkedMovement) {
        linkedCashAssetId = linkedMovement.fund_asset_id;
        await repos.transactionRepo.deleteBySourceDivestmentTxnId(id);
      }
      await repos.transactionRepo.delete(id);
    });

    await this.fundMetricsService.recomputeAsset(assetId, true);
    if (linkedCashAssetId) {
      await this.fundMetricsService.recomputeAsset(linkedCashAssetId, true);
    }
    if (deletedFundId) {
      await this.fundMetricsService.recomputeFund(deletedFundId);
    }
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
