import type {
  FundAssetRepository,
  FundRepository,
  Tables,
  TablesInsert,
  TablesUpdate,
} from '@/lib/repositories';
import type { FundMetricsService } from './fundMetricsService';

export class FundNotFoundError extends Error {
  constructor(id: string) {
    super(`Fund ${id} not found`);
    this.name = 'FundNotFoundError';
  }
}

export class FundAssetNotFoundError extends Error {
  constructor(id: string) {
    super(`Fund asset ${id} not found`);
    this.name = 'FundAssetNotFoundError';
  }
}

export class FundService {
  constructor(
    private readonly fundRepo: FundRepository,
    private readonly fundAssetRepo: FundAssetRepository,
    private readonly fundMetricsService: FundMetricsService,
  ) {}

  listFunds(): Promise<Tables<'funds'>[]> {
    return this.fundRepo.findAll();
  }

  async getFund(id: string): Promise<Tables<'funds'>> {
    const fund = await this.fundRepo.findById(id);
    if (!fund) throw new FundNotFoundError(id);
    return fund;
  }

  createFund(data: Omit<TablesInsert<'funds'>, 'workspace_id'>): Promise<Tables<'funds'>> {
    return this.fundRepo.insert(data);
  }

  async updateFund(id: string, updates: TablesUpdate<'funds'>): Promise<Tables<'funds'>> {
    const row = await this.fundRepo.update(id, updates);
    if (!row) throw new FundNotFoundError(id);
    return row;
  }

  listAssets(fundId: string): Promise<Tables<'fund_assets'>[]> {
    return this.fundAssetRepo.findByFundId(fundId);
  }

  listUnassignedAssets(): Promise<Tables<'fund_assets'>[]> {
    return this.fundAssetRepo.findUnassignedAssets();
  }

  async getAsset(id: string): Promise<Tables<'fund_assets'>> {
    const asset = await this.fundAssetRepo.findById(id);
    if (!asset) throw new FundAssetNotFoundError(id);
    return asset;
  }

  async addAsset(
    data: Omit<TablesInsert<'fund_assets'>, 'workspace_id'>,
  ): Promise<Tables<'fund_assets'>> {
    const asset = await this.fundAssetRepo.insert(data);
    await this.fundMetricsService.recomputeAsset(asset.id);
    return this.getAsset(asset.id);
  }

  async updateAsset(
    id: string,
    updates: TablesUpdate<'fund_assets'>,
  ): Promise<Tables<'fund_assets'>> {
    const existing = await this.getAsset(id);
    let isManuallyOverridden = existing.is_manually_overridden;
    
    if (
      (updates.gross_moic !== undefined && updates.gross_moic !== existing.gross_moic) ||
      (updates.invested_capital_amount !== undefined && updates.invested_capital_amount !== existing.invested_capital_amount) ||
      (updates.net_distribution_amount !== undefined && updates.net_distribution_amount !== existing.net_distribution_amount) ||
      (updates.share_count !== undefined && updates.share_count !== existing.share_count) ||
      (updates.fmv_amount !== undefined && updates.fmv_amount !== existing.fmv_amount)
    ) {
      isManuallyOverridden = true;
      updates.is_manually_overridden = true;
    }

    const row = await this.fundAssetRepo.update(id, updates);
    if (!row) throw new FundAssetNotFoundError(id);
    
    await this.fundMetricsService.recomputeAsset(id, false);
    return this.getAsset(id);
  }

  // Deleting a fund removes the fund and its own fund-level rows (pledges in
  // fund_investor_stakes, history in fund_valuations — both ON DELETE CASCADE),
  // but NOT the ledger: fund_asset_transactions.fund_id is ON DELETE SET NULL,
  // so a deleted fund's transactions (and the assets they belong to) survive and
  // fall into "Unassigned Assets". Assets carry no fund_id post-refactor, so they
  // are never touched here — only deleting an asset cascade-deletes its own
  // transactions/valuations.
  async deleteFund(id: string): Promise<void> {
    await this.getFund(id);
    await this.fundRepo.delete(id);
  }

  async deleteAsset(id: string): Promise<void> {
    await this.getAsset(id);
    await this.fundAssetRepo.delete(id);
  }
}
