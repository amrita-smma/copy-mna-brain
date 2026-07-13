import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FundPortfolioService } from './fundPortfolioService';
import type {
  FundAssetRepository,
  FundAssetTransactionRepository,
  FundAssetValuationRepository,
  FundRepository,
} from '@/lib/repositories';

describe('FundPortfolioService', () => {
  let fundRepo: { findAll: ReturnType<typeof vi.fn> };
  let fundAssetRepo: {
    findByFundIds: ReturnType<typeof vi.fn>;
    findUnassignedAssets: ReturnType<typeof vi.fn>;
  };
  let transactionRepo: { findByFundAssetIds: ReturnType<typeof vi.fn> };
  let valuationRepo: { findByFundAssetIds: ReturnType<typeof vi.fn> };
  let service: FundPortfolioService;

  beforeEach(() => {
    fundRepo = { findAll: vi.fn() };
    fundAssetRepo = { findByFundIds: vi.fn(), findUnassignedAssets: vi.fn() };
    transactionRepo = { findByFundAssetIds: vi.fn() };
    valuationRepo = { findByFundAssetIds: vi.fn() };
    service = new FundPortfolioService(
      fundRepo as unknown as FundRepository,
      fundAssetRepo as unknown as FundAssetRepository,
      transactionRepo as unknown as FundAssetTransactionRepository,
      valuationRepo as unknown as FundAssetValuationRepository,
      'ws1',
    );
  });

  it('assembles funds with each asset\'s ledger via batched queries, keyed by fund_asset_id', async () => {
    fundRepo.findAll.mockResolvedValueOnce([
      { id: 'f1', name: 'Fund I', commitment_size_amount: 0 },
      { id: 'f2', name: 'Fund II', commitment_size_amount: 0 },
    ]);
    fundAssetRepo.findByFundIds.mockResolvedValueOnce([
      { fundId: 'f1', asset: { id: 'a1' } },
      { fundId: 'f2', asset: { id: 'a2' } },
      // co-invested asset shared across both funds appears once per fund
      { fundId: 'f1', asset: { id: 'a3' } },
      { fundId: 'f2', asset: { id: 'a3' } },
    ]);
    fundAssetRepo.findUnassignedAssets.mockResolvedValueOnce([]);
    transactionRepo.findByFundAssetIds.mockResolvedValueOnce([
      { id: 't1', fund_asset_id: 'a1' },
      { id: 't2', fund_asset_id: 'a3' },
    ]);
    valuationRepo.findByFundAssetIds.mockResolvedValueOnce([{ id: 'v1', fund_asset_id: 'a2' }]);

    const portfolio = await service.getPortfolio();

    // Only unique asset ids are queried, in one batched call each.
    expect(transactionRepo.findByFundAssetIds).toHaveBeenCalledWith(['a1', 'a2', 'a3']);
    expect(valuationRepo.findByFundAssetIds).toHaveBeenCalledWith(['a1', 'a2', 'a3']);

    expect(portfolio).toHaveLength(2);
    const f1 = portfolio.find((f) => f.id === 'f1')!;
    expect(f1.assets.map((a) => a.asset.id)).toEqual(['a1', 'a3']);
    expect(f1.assets.find((a) => a.asset.id === 'a1')!.txns).toEqual([
      { id: 't1', fund_asset_id: 'a1' },
    ]);
    // The co-invested asset carries its full ledger under each fund it belongs to.
    const a3UnderF1 = f1.assets.find((a) => a.asset.id === 'a3')!;
    const a3UnderF2 = portfolio.find((f) => f.id === 'f2')!.assets.find((a) => a.asset.id === 'a3')!;
    expect(a3UnderF1.txns).toEqual([{ id: 't2', fund_asset_id: 'a3' }]);
    expect(a3UnderF2.txns).toEqual([{ id: 't2', fund_asset_id: 'a3' }]);
    // Assets with no ledger rows get empty arrays, never undefined.
    expect(portfolio.find((f) => f.id === 'f2')!.assets.find((a) => a.asset.id === 'a2')!.valuations)
      .toEqual([{ id: 'v1', fund_asset_id: 'a2' }]);
    expect(a3UnderF1.valuations).toEqual([]);
  });

  it('appends the synthetic "unassigned" fund only when unassigned assets exist', async () => {
    fundRepo.findAll.mockResolvedValue([{ id: 'f1', name: 'Fund I', commitment_size_amount: 0 }]);
    fundAssetRepo.findByFundIds.mockResolvedValue([{ fundId: 'f1', asset: { id: 'a1' } }]);
    transactionRepo.findByFundAssetIds.mockResolvedValue([]);
    valuationRepo.findByFundAssetIds.mockResolvedValue([]);

    fundAssetRepo.findUnassignedAssets.mockResolvedValueOnce([{ id: 'a9' }]);
    const withUnassigned = await service.getPortfolio();
    expect(withUnassigned.map((f) => f.id)).toEqual(['f1', 'unassigned']);
    expect(withUnassigned.find((f) => f.id === 'unassigned')!.assets.map((a) => a.asset.id)).toEqual([
      'a9',
    ]);

    fundAssetRepo.findUnassignedAssets.mockResolvedValueOnce([]);
    const withoutUnassigned = await service.getPortfolio();
    expect(withoutUnassigned.map((f) => f.id)).toEqual(['f1']);
  });
});
