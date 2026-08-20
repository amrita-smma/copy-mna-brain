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
  const transactionRepo = { findByFundAssetId: vi.fn(), findByFundAssetIds: vi.fn() };
  const valuationRepo = { findLatestByFundAssetId: vi.fn(), findByFundAssetIds: vi.fn() };
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
      const ledger = [
        { fund_asset_id: 'a1', txn_type: 'contribution', txn_date: '2023-01-01', price_per_share: 5, share_count: 10, value_amount: null, fx_rate: null, fund_id: 'f1' },
        { fund_asset_id: 'a1', txn_type: 'divestment', txn_date: '2024-01-01', price_per_share: 8, share_count: 2, value_amount: null, fx_rate: null, fund_id: 'f1' },
      ];
      repos.fundAssetRepo.findById.mockResolvedValueOnce(asset);
      repos.transactionRepo.findByFundAssetId.mockResolvedValue(ledger);
      // recomputeFund's sweep re-fetches the fund's assets and batches the ledger.
      repos.fundAssetRepo.findByFundId.mockResolvedValueOnce([asset]);
      repos.transactionRepo.findByFundAssetIds.mockResolvedValue(ledger);
      repos.valuationRepo.findByFundAssetIds.mockResolvedValue([]);

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
      const ledger = [
        { fund_asset_id: 'a2', txn_type: 'contribution', txn_date: '2023-01-01', price_per_share: null, share_count: null, value_amount: 100, fx_rate: null, fund_id: 'f1' },
      ];
      repos.fundAssetRepo.findById.mockResolvedValueOnce(asset);
      repos.transactionRepo.findByFundAssetId.mockResolvedValue(ledger);
      repos.valuationRepo.findLatestByFundAssetId.mockResolvedValue({ market_value_amount: 120 });
      repos.fundAssetRepo.findByFundId.mockResolvedValueOnce([asset]);
      repos.transactionRepo.findByFundAssetIds.mockResolvedValue(ledger);
      repos.valuationRepo.findByFundAssetIds.mockResolvedValue([{ fund_asset_id: 'a2', market_value_amount: 120 }]);

      await service.recomputeAsset('a2');

      expect(repos.fundAssetRepo.update).toHaveBeenCalledWith('a2', expect.objectContaining({
        share_count: 0,
        invested_capital_amount: 100,
        gross_moic: 1.2, // (0 + 120) / 100
      }));
    });

    it('computes cash asset balance from valuation and post-valuation cash flows', async () => {
      const cashAsset = {
        id: 'cash-1',
        fund_id: 'f1',
        asset_type: 'cash',
        current_price_per_share: null,
        investment_currency: 'USD',
        report_currency: 'USD',
        entry_date: '2023-01-01',
      };
      const ledger = [
        { fund_asset_id: 'cash-1', txn_type: 'contribution', txn_date: '2023-01-01', value_amount: 1000, fx_rate: 1, fund_id: 'f1' },
        { fund_asset_id: 'cash-1', txn_type: 'internal_transfer', txn_date: '2023-06-01', value_amount: 500, fx_rate: 1, fund_id: 'f1' }, // prior to valuation
        { fund_asset_id: 'cash-1', txn_type: 'internal_transfer', txn_date: '2023-08-01', value_amount: 300, fx_rate: 1, fund_id: 'f1' }, // after valuation
        { fund_asset_id: 'cash-1', txn_type: 'divestment', sell_proceeds_destination: 'distributed_to_investor', txn_date: '2023-09-01', value_amount: 100, fx_rate: 1, fund_id: 'f1' }, // after valuation
      ];
      const valuation = {
        fund_asset_id: 'cash-1',
        as_of_date: '2023-06-30',
        market_value_amount: 1500,
      };
      repos.fundAssetRepo.findById.mockResolvedValueOnce(cashAsset);
      repos.transactionRepo.findByFundAssetId.mockResolvedValue(ledger);
      repos.valuationRepo.findLatestByFundAssetId.mockResolvedValue(valuation);
      repos.fundAssetRepo.findByFundId.mockResolvedValueOnce([cashAsset]);
      repos.transactionRepo.findByFundAssetIds.mockResolvedValue(ledger);
      repos.valuationRepo.findByFundAssetIds.mockResolvedValue([valuation]);

      await service.recomputeAsset('cash-1');

      // Cash balance should be: 1500 (base at 2023-06-30) + 300 (transfer) - 100 (distribution) = 1700
      expect(repos.fundAssetRepo.update).toHaveBeenCalledWith('cash-1', expect.objectContaining({
        fmv_amount: 1700,
      }));
    });

    it('excludes cash_in_fund divestment proceeds and internal_transfer from fund realized_amount', async () => {
      const equityAsset = {
        id: 'eq-1',
        fund_id: 'f1',
        asset_type: 'equity',
        current_price_per_share: null,
        investment_currency: 'USD',
        report_currency: 'USD',
        entry_date: '2023-01-01',
      };
      const cashAsset = {
        id: 'cash-1',
        fund_id: 'f1',
        asset_type: 'cash',
        current_price_per_share: null,
        investment_currency: 'USD',
        report_currency: 'USD',
        entry_date: '2023-01-01',
      };

      const equityLedger = [
        { fund_asset_id: 'eq-1', txn_type: 'contribution', txn_date: '2023-01-01', value_amount: 1000, fx_rate: 1, fund_id: 'f1' },
        // Divestment proceeds kept in fund
        { fund_asset_id: 'eq-1', txn_type: 'divestment', txn_date: '2023-07-01', value_amount: 400, fx_rate: 1, sell_proceeds_destination: 'cash_in_fund', fund_id: 'f1' },
        // Divestment proceeds distributed to LPs
        { fund_asset_id: 'eq-1', txn_type: 'divestment', txn_date: '2023-08-01', value_amount: 200, fx_rate: 1, sell_proceeds_destination: 'distributed_to_investor', fund_id: 'f1' },
      ];
      const cashLedger = [
        // Linked movement for the $400 cash_in_fund
        { fund_asset_id: 'cash-1', txn_type: 'internal_transfer', txn_date: '2023-07-01', value_amount: 400, fx_rate: 1, fund_id: 'f1' },
      ];
      const allTxns = [...equityLedger, ...cashLedger];

      repos.fundAssetRepo.findById.mockResolvedValueOnce(equityAsset);
      repos.transactionRepo.findByFundAssetId.mockResolvedValue(equityLedger);
      repos.valuationRepo.findLatestByFundAssetId.mockResolvedValue(undefined);
      repos.fundAssetRepo.findByFundId.mockResolvedValueOnce([equityAsset, cashAsset]);
      repos.transactionRepo.findByFundAssetIds.mockResolvedValue(allTxns);
      repos.valuationRepo.findByFundAssetIds.mockResolvedValue([]);

      await service.recomputeAsset('eq-1');

      expect(repos.fundRepo.update).toHaveBeenCalledWith('f1', expect.objectContaining({
        called_amount: 1000,
        realized_amount: 200, // ONLY the distributed_to_investor divestment ($200), NOT the cash_in_fund ($400) or internal_transfer ($400)
        fmv_amount: 400, // Cash asset has $400 balance
        dpi: 0.2, // 200 / 1000
        tvpi: 0.6, // (200 + 400) / 1000
      }));
    });

    it('subtracts shares and realizes pps × shares for a divestment with share data (the folded distribution case)', async () => {
      const asset = {
        id: 'asset-1',
        fund_id: 'f1',
        asset_type: 'direct_investment',
        current_price_per_share: 20,
        investment_currency: 'USD',
        report_currency: 'USD',
        entry_date: '2023-01-01',
      };
      const ledger = [
        {
          fund_asset_id: 'asset-1',
          txn_type: 'contribution',
          txn_date: '2023-01-01',
          share_count: 10000,
          price_per_share: 10,
          value_amount: 100000,
          fx_rate: 1,
          fund_id: 'f1',
        },
        // Divestment (the folded distribution case) with share_count + price_per_share and null value_amount
        {
          fund_asset_id: 'asset-1',
          txn_type: 'divestment',
          sell_proceeds_destination: 'distributed_to_investor',
          txn_date: '2023-06-01',
          share_count: 2000,
          price_per_share: 15,
          value_amount: null,
          fx_rate: 1,
          fund_id: 'f1',
        },
      ];

      repos.fundAssetRepo.findById.mockResolvedValueOnce(asset);
      repos.transactionRepo.findByFundAssetId.mockResolvedValue(ledger);
      repos.valuationRepo.findLatestByFundAssetId.mockResolvedValue(undefined);
      repos.fundAssetRepo.findByFundId.mockResolvedValueOnce([asset]);
      repos.transactionRepo.findByFundAssetIds.mockResolvedValue(ledger);
      repos.valuationRepo.findByFundAssetIds.mockResolvedValue([]);

      await service.recomputeAsset('asset-1');

      // 10,000 acquired - 2,000 disposed = 8,000 shares remaining
      // 15 * 2,000 = $30,000 net distribution
      // 8,000 shares * $20/share = $160,000 unrealized FMV
      // Total value = 30,000 + 160,000 = 190,000
      // Gross MOIC = 190,000 / 100,000 = 1.9
      // DPI = 30,000 / 100,000 = 0.3
      expect(repos.fundAssetRepo.update).toHaveBeenCalledWith('asset-1', expect.objectContaining({
        share_count: 8000,
        net_distribution_amount: 30000,
        invested_capital_amount: 100000,
        fmv_amount: 160000,
        dpi: 0.3,
        gross_moic: 1.9,
      }));
    });
  });
});
