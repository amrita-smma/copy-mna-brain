import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FundMetricsService } from './fundMetricsService';
import type {
  FundAssetRepository,
  FundAssetTransactionRepository,
  FundAssetValuationRepository,
  FundRepository,
} from '@/lib/repositories';

function makeRepos() {
  const fundRepo = { update: vi.fn() };
  const fundAssetRepo = { findById: vi.fn(), findByFundId: vi.fn(), update: vi.fn() };
  const transactionRepo = { findByFundAssetId: vi.fn() };
  const valuationRepo = { findLatestByFundAssetId: vi.fn() };
  return { fundRepo, fundAssetRepo, transactionRepo, valuationRepo };
}

describe('FundMetricsService', () => {
  let repos: ReturnType<typeof makeRepos>;
  let service: FundMetricsService;

  beforeEach(() => {
    repos = makeRepos();
    service = new FundMetricsService(
      repos.fundRepo as unknown as FundRepository,
      repos.fundAssetRepo as unknown as FundAssetRepository,
      repos.transactionRepo as unknown as FundAssetTransactionRepository,
      repos.valuationRepo as unknown as FundAssetValuationRepository,
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('recomputeAsset', () => {
    it('does nothing when the asset does not exist', async () => {
      repos.fundAssetRepo.findById.mockResolvedValueOnce(undefined);
      await service.recomputeAsset('missing');
      expect(repos.fundAssetRepo.update).not.toHaveBeenCalled();
      expect(repos.fundRepo.update).not.toHaveBeenCalled();
    });

    it('computes rollups from the ledger and writes them back, then rolls up the fund', async () => {
      const asset = {
        id: 'a1',
        fund_id: 'f1',
        current_price_per_share: 10,
        investment_currency: 'USD',
        report_currency: 'USD',
        entry_date: '2023-01-01',
      };
      repos.fundAssetRepo.findById.mockResolvedValueOnce(asset);
      repos.transactionRepo.findByFundAssetId.mockResolvedValue([
        { txn_type: 'contribution', txn_date: '2023-01-01', price_per_share: 5, share_count: 10, value_amount: null, fx_rate: null, fund_id: 'f1' },
        { txn_type: 'divestment', txn_date: '2024-01-01', price_per_share: 8, share_count: 2, value_amount: null, fx_rate: null, fund_id: 'f1' },
      ]);
      // recomputeFund's per-asset sweep re-fetches the asset list for the fund.
      repos.fundAssetRepo.findByFundId.mockResolvedValueOnce([asset]);

      await service.recomputeAsset('a1');

      expect(repos.fundAssetRepo.update).toHaveBeenCalledWith('a1', expect.objectContaining({
        share_count: 8, // 10 acquired - 2 disposed
        invested_capital_amount: 50, // 5 * 10 contribution
        net_distribution_amount: 16, // 8 * 2 divestment
        dpi: 0.32, // 16 / 50
        gross_moic: 1.92, // (16 + 8*10) / 50
      }));

      expect(repos.fundRepo.update).toHaveBeenCalledWith('f1', expect.objectContaining({
        called_amount: 50,
        realized_amount: 16,
        fmv_amount: 80,
        dpi: 0.32,
        tvpi: 1.92,
      }));
    });

    it('falls back to the latest valuation for flat-value assets with no shares', async () => {
      const asset = {
        id: 'a2',
        fund_id: 'f1',
        current_price_per_share: null,
        investment_currency: 'USD',
        report_currency: 'USD',
        entry_date: '2023-01-01',
      };
      repos.fundAssetRepo.findById.mockResolvedValueOnce(asset);
      repos.transactionRepo.findByFundAssetId.mockResolvedValue([
        { txn_type: 'contribution', txn_date: '2023-01-01', price_per_share: null, share_count: null, value_amount: 100, fx_rate: null, fund_id: 'f1' },
      ]);
      repos.valuationRepo.findLatestByFundAssetId.mockResolvedValue({ market_value_amount: 120 });
      repos.fundAssetRepo.findByFundId.mockResolvedValueOnce([asset]);

      await service.recomputeAsset('a2');

      expect(repos.fundAssetRepo.update).toHaveBeenCalledWith('a2', expect.objectContaining({
        share_count: 0,
        invested_capital_amount: 100,
        gross_moic: 1.2, // (0 + 120) / 100
      }));
    });
  });
});
