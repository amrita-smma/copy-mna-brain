import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient, Tables } from '@/lib/repositories';
import { flAdd, flSub } from './flDecimal';
import { FlBalanceService } from './flBalanceService';

describe('FlBalanceService', () => {
  let mockDb: any;
  let mockLedgerRepo: any;
  let mockPositionRepo: any;
  let mockFundRepo: any;
  let mockAssetRepo: any;
  let mockValuationRepo: any;
  let service: FlBalanceService;

  const workspaceId = 'ws-balance-1';

  beforeEach(() => {
    mockDb = {};
    mockLedgerRepo = {
      sumDeltasByPositionIds: vi.fn().mockResolvedValue([]),
      findAllByPositionIds: vi.fn().mockResolvedValue([]),
      findByPositionIds: vi.fn().mockResolvedValue([]),
    };
    mockPositionRepo = {
      findById: vi.fn().mockResolvedValue(undefined),
      findByFundIds: vi.fn().mockResolvedValue([]),
      findByHolderFundIds: vi.fn().mockResolvedValue([]),
      findByAssetIds: vi.fn().mockResolvedValue([]),
    };
    mockFundRepo = {
      findById: vi.fn().mockResolvedValue(undefined),
      findByIds: vi.fn().mockResolvedValue([]),
    };
    mockAssetRepo = {
      findById: vi.fn().mockResolvedValue(undefined),
    };
    mockValuationRepo = {
      findLatestByPositionIds: vi.fn().mockResolvedValue([]),
      findLatestByAssetIds: vi.fn().mockResolvedValue([]),
      findLatestByFundIds: vi.fn().mockResolvedValue([]),
    };

    service = new FlBalanceService(
      mockDb,
      mockLedgerRepo,
      mockPositionRepo,
      mockFundRepo,
      mockAssetRepo,
      mockValuationRepo,
    );
  });

  describe('getPositionBalances & RFC Lifecycle', () => {
    it('computes position balances correctly across Company-A lifecycle steps', async () => {
      // Step 1: 100M commitment
      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValueOnce([
        {
          position_id: 'pos-lp-1',
          commitment_sum: '100000000.00000000',
          quantity_sum: '0.00000000',
          cash_sum: '0.00000000',
          contributed_sum: '0.00000000',
        },
      ]);

      const [step1] = await service.getPositionBalances(workspaceId, ['pos-lp-1']);
      expect(step1.committed).toBe('100000000.00000000');
      expect(step1.contributed).toBe('0.00000000');
      expect(step1.unfunded).toBe('100000000.00000000');
      expect(step1.cash_total).toBe('0.00000000');
      expect(step1.valuation_adjustment).toBe('0.00000000');

      // Step 2: 50M paid-in
      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValueOnce([
        {
          position_id: 'pos-lp-1',
          commitment_sum: '100000000.00000000',
          quantity_sum: '50000.00000000',
          cash_sum: '-50000000.00000000',
          contributed_sum: '50000000.00000000',
        },
      ]);

      const [step2] = await service.getPositionBalances(workspaceId, ['pos-lp-1']);
      expect(step2.committed).toBe('100000000.00000000');
      expect(step2.contributed).toBe('50000000.00000000');
      expect(step2.unfunded).toBe('50000000.00000000');
      expect(step2.quantity).toBe('50000.00000000');
      expect(step2.cash_total).toBe('-50000000.00000000');

      // Step 3: Reversal of paid-in reduces contributed back to 0
      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValueOnce([
        {
          position_id: 'pos-lp-1',
          commitment_sum: '100000000.00000000',
          quantity_sum: '0.00000000',
          cash_sum: '0.00000000',
          contributed_sum: '0.00000000', // net of normal (-50M) and reversal (+50M) is 0
        },
      ]);

      const [step3] = await service.getPositionBalances(workspaceId, ['pos-lp-1']);
      expect(step3.contributed).toBe('0.00000000');
      expect(step3.unfunded).toBe('100000000.00000000');
    });

    it('getPositionBalances before reversal date preserves original balances and on/after reversal nets to zero without mocking the final net result', async () => {
      // Discrete raw ledger entries across time
      const rawEntries = [
        {
          position_id: 'pos-lp-1',
          entry_date: '2026-01-15',
          entry_type: 'paid_in',
          commitment_delta: '100000000.00000000',
          quantity_delta: '50000.00000000',
          cash_delta: '-50000000.00000000',
          valuation_delta: '0.00000000',
          is_reversal: false,
        },
        {
          position_id: 'pos-lp-1',
          entry_date: '2026-05-20',
          entry_type: 'paid_in',
          commitment_delta: '0.00000000',
          quantity_delta: '-50000.00000000',
          cash_delta: '50000000.00000000',
          valuation_delta: '0.00000000',
          is_reversal: true,
        },
      ];

      // Repository sum function accurately simulates date-filtering and summing of raw entries
      // rather than returning a pre-canned hardcoded net result.
      mockLedgerRepo.sumDeltasByPositionIds.mockImplementation(
        async (_ws: string, positionIds: string[], asOfDate?: string) => {
          return positionIds.map((posId) => {
            const filtered = rawEntries.filter(
              (e) => e.position_id === posId && (!asOfDate || e.entry_date <= asOfDate),
            );

            let commitmentSum = '0.00000000';
            let quantitySum = '0.00000000';
            let cashSum = '0.00000000';
            let contributedSum = '0.00000000';
            let valuationDeltaSum = '0.00000000';

            for (const row of filtered) {
              commitmentSum = flAdd(commitmentSum, row.commitment_delta);
              quantitySum = flAdd(quantitySum, row.quantity_delta);
              cashSum = flAdd(cashSum, row.cash_delta);
              valuationDeltaSum = flAdd(valuationDeltaSum, row.valuation_delta);
              if (row.entry_type === 'paid_in' || row.entry_type === 'buy') {
                contributedSum = flSub(contributedSum, row.cash_delta);
              }
            }

            return {
              position_id: posId,
              commitment_sum: commitmentSum,
              quantity_sum: quantitySum,
              cash_sum: cashSum,
              contributed_sum: contributedSum,
              valuation_delta_sum: valuationDeltaSum,
            };
          });
        },
      );

      // As of 2026-03-31 (before reversal date 2026-05-20), original balance is preserved
      const [beforeReversal] = await service.getPositionBalances(workspaceId, ['pos-lp-1'], '2026-03-31');
      expect(beforeReversal.contributed).toBe('50000000.00000000');
      expect(beforeReversal.quantity).toBe('50000.00000000');
      expect(beforeReversal.cash_total).toBe('-50000000.00000000');
      expect(beforeReversal.unfunded).toBe('50000000.00000000');

      // As of 2026-05-20 (reversal date), reversal entries take effect and net economics to zero
      const [onReversal] = await service.getPositionBalances(workspaceId, ['pos-lp-1'], '2026-05-20');
      expect(onReversal.contributed).toBe('0.00000000');
      expect(onReversal.quantity).toBe('0.00000000');
      expect(onReversal.cash_total).toBe('0.00000000');
      expect(onReversal.unfunded).toBe('100000000.00000000');

      // As of 2026-06-30 (post-reversal), remains netted to zero
      const [afterReversal] = await service.getPositionBalances(workspaceId, ['pos-lp-1'], '2026-06-30');
      expect(afterReversal.contributed).toBe('0.00000000');
      expect(afterReversal.quantity).toBe('0.00000000');
      expect(afterReversal.cash_total).toBe('0.00000000');

      // Current view (no asOfDate) nets to zero
      const [currentView] = await service.getPositionBalances(workspaceId, ['pos-lp-1']);
      expect(currentView.contributed).toBe('0.00000000');
      expect(currentView.quantity).toBe('0.00000000');
      expect(currentView.cash_total).toBe('0.00000000');
    });

    it('reduces paid-in without changing cash, distributions, commitment or valuation', async () => {
      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValueOnce([{
        position_id: 'pos-lp-1', commitment_sum: '115295064.12', quantity_sum: '0',
        contributed_sum: '149364561.45', cash_sum: '-116209845.49',
        paid_in_adjustment_sum: '-914781.37', valuation_delta_sum: '0',
      }]);
      const [balance] = await service.getPositionBalances(workspaceId, ['pos-lp-1']);
      expect(balance.contributed).toBe('148449780.08000000');
      expect(balance.drawn_commitment).toBe('148449780.08000000');
      expect(balance.committed).toBe('115295064.12000000');
      expect(balance.cash_total).toBe('-116209845.49000000');
      expect(balance.distributed).toBe('33154715.96000000');
      expect(balance.valuation_adjustment).toBe('0.00000000');
      // Reported separately so a caller can recover cash paid-in.
      expect(balance.paid_in_adjustment).toBe('-914781.37000000');
    });

    it('exposes non-cash valuation adjustments without changing contributed capital', async () => {
      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValueOnce([
        {
          position_id: 'pos-lp-1',
          commitment_sum: '100000000.00000000',
          quantity_sum: '0.00000000',
          cash_sum: '-50000000.00000000',
          contributed_sum: '50000000.00000000',
          valuation_delta_sum: '-914781.37000000',
        },
      ]);

      const [balance] = await service.getPositionBalances(workspaceId, ['pos-lp-1']);

      expect(balance.valuation_adjustment).toBe('-914781.37000000');
      expect(balance.contributed).toBe('50000000.00000000');
      expect(balance.cash_total).toBe('-50000000.00000000');
    });

    it('computes distributed amount accurately when cash distributions occur', async () => {
      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-lp-1',
          commitment_sum: '1000000.00000000',
          quantity_sum: '1000.00000000',
          cash_sum: '-800000.00000000', // paid 1M, received 200k distribution -> net cash -800k
          contributed_sum: '1000000.00000000',
        },
      ]);

      const [b] = await service.getPositionBalances(workspaceId, ['pos-lp-1']);
      expect(b.contributed).toBe('1000000.00000000');
      expect(b.distributed).toBe('200000.00000000');
    });

    it('computes contributed and distributed amounts for asset positions with buy and sell', async () => {
      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-asset-1',
          commitment_sum: '0.00000000',
          quantity_sum: '500.00000000',
          cash_sum: '-600000.00000000', // bought for 1M, sold half for 400k -> net cash -600k
          contributed_sum: '1000000.00000000', // buy counted in contributed_sum
        },
      ]);

      const [b] = await service.getPositionBalances(workspaceId, ['pos-asset-1']);
      expect(b.contributed).toBe('1000000.00000000');
      expect(b.contributed_capital).toBe('1000000.00000000');
      expect(b.distributed).toBe('400000.00000000');
      expect(b.distributed_capital).toBe('400000.00000000');
      expect(b.cash_total).toBe('-600000.00000000');
    });
  });

  describe('Valuation Precedence & Pro-Rata NAV', () => {
    it('applies explicit position valuation (CAS) overriding asset/fund valuation', async () => {
      const pos = { id: 'pos-cas-1', asset_id: 'asset-1', fund_id: null } as any;

      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-cas-1',
          commitment_sum: '0',
          quantity_sum: '100',
          cash_sum: '-1000',
          contributed_sum: '0',
        },
      ]);

      mockValuationRepo.findLatestByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-cas-1',
          market_value: '2500.00000000',
          valuation_method: 'capital_account_statement',
        },
      ]);

      mockValuationRepo.findLatestByAssetIds.mockResolvedValue([
        {
          asset_id: 'asset-1',
          price_per_unit: '50.00000000', // 100 * 50 = 5000
          valuation_method: 'fundraise_round',
        },
      ]);

      const [val] = await service.getPositionValues(workspaceId, [pos]);
      expect(val.value).toBe('2500.00000000');
      expect(val.method).toBe('capital_account_statement');
    });

    it('values asset position using price_per_unit × quantity', async () => {
      const pos = { id: 'pos-asset-1', asset_id: 'asset-1', fund_id: null } as any;

      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-asset-1',
          commitment_sum: '0',
          quantity_sum: '250.00000000',
          cash_sum: '-5000.00000000',
          contributed_sum: '0',
        },
      ]);

      mockValuationRepo.findLatestByPositionIds.mockResolvedValue([]);
      mockValuationRepo.findLatestByAssetIds.mockResolvedValue([
        {
          asset_id: 'asset-1',
          price_per_unit: '40.00000000',
          valuation_method: 'listed_price',
        },
      ]);

      const [val] = await service.getPositionValues(workspaceId, [pos]);
      // 250 * 40 = 10000
      expect(val.value).toBe('10000.00000000');
      expect(val.method).toBe('listed_price');
    });

    it('values asset position by deriving per-unit mark from market_value / units_outstanding', async () => {
      const pos = { id: 'pos-asset-2', asset_id: 'asset-2', fund_id: null } as any;

      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-asset-2',
          commitment_sum: '0',
          quantity_sum: '500.00000000',
          cash_sum: '-20000.00000000',
          contributed_sum: '0',
        },
      ]);

      mockValuationRepo.findLatestByPositionIds.mockResolvedValue([]);
      mockValuationRepo.findLatestByAssetIds.mockResolvedValue([
        {
          asset_id: 'asset-2',
          market_value: '1000000.00000000',
          units_outstanding: '10000.00000000', // ppu = 100
          price_per_unit: null,
          valuation_method: 'fundraise_round',
        },
      ]);

      const [val] = await service.getPositionValues(workspaceId, [pos]);
      // 500 * 100 = 50000
      expect(val.value).toBe('50000.00000000');
      expect(val.method).toBe('fundraise_round');
    });

    it('returns zero value and null method when asset valuation is missing (no fake at-cost)', async () => {
      const pos = { id: 'pos-asset-3', asset_id: 'asset-3', fund_id: null } as any;

      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-asset-3',
          commitment_sum: '0',
          quantity_sum: '500.00000000',
          cash_sum: '-20000.00000000',
          contributed_sum: '0',
        },
      ]);

      mockValuationRepo.findLatestByPositionIds.mockResolvedValue([]);
      mockValuationRepo.findLatestByAssetIds.mockResolvedValue([]); // No mark

      const [val] = await service.getPositionValues(workspaceId, [pos]);
      expect(val.value).toBe('0.00000000');
      expect(val.method).toBeNull();
    });

    it('values asset position using market_value fallback when uniquely attributable across workspace (AC 1)', async () => {
      const pos = {
        id: 'pos-single-asset',
        asset_id: 'asset-single',
        fund_id: null,
      } as any;

      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-single-asset',
          commitment_sum: '0',
          quantity_sum: '0',
          cash_sum: '-1000000',
          contributed_sum: '1000000',
        },
      ]);

      mockValuationRepo.findLatestByPositionIds.mockResolvedValue([]);
      mockValuationRepo.findLatestByAssetIds.mockResolvedValue([
        {
          asset_id: 'asset-single',
          market_value: '2500000.00000000',
          price_per_unit: null,
          units_outstanding: null,
          valuation_method: 'other',
        },
      ]);
      mockPositionRepo.findByAssetIds.mockResolvedValue([pos]); // exactly 1 position in workspace

      const [val] = await service.getPositionValues(workspaceId, [pos]);
      expect(val.value).toBe('2500000.00000000');
      expect(val.method).toBe('other');
    });

    it('falls through to market value when PPS exists with quantity zero/untracked (AC 2)', async () => {
      const pos = {
        id: 'pos-shareless-pps',
        asset_id: 'asset-pps',
        fund_id: null,
      } as any;

      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-shareless-pps',
          commitment_sum: '0',
          quantity_sum: '0.00000000',
          cash_sum: '-500000',
          contributed_sum: '500000',
        },
      ]);

      mockValuationRepo.findLatestByPositionIds.mockResolvedValue([]);
      mockValuationRepo.findLatestByAssetIds.mockResolvedValue([
        {
          asset_id: 'asset-pps',
          price_per_unit: '10.00000000',
          market_value: '2500000.00000000',
          valuation_method: 'fundraise_round',
        },
      ]);
      mockPositionRepo.findByAssetIds.mockResolvedValue([pos]);

      const [val] = await service.getPositionValues(workspaceId, [pos]);
      // With quantity = 0, PPS is NOT multiplied by 0. Falls through to market_value 2.5M.
      expect(val.value).toBe('2500000.00000000');
      expect(val.method).toBe('fundraise_round');
    });

    it('allocates asset market value across multiple shareless positions proportionally by contributed capital (AC 3)', async () => {
      const pos1 = {
        id: 'pos-asset-1',
        asset_id: 'asset-multi',
        fund_id: null,
      } as any;
      const pos2 = {
        id: 'pos-asset-2',
        asset_id: 'asset-multi',
        fund_id: null,
      } as any;

      mockLedgerRepo.sumDeltasByPositionIds.mockImplementation((_ws: string, ids: string[]) => {
        const rows: any[] = [];
        if (ids.includes('pos-asset-1')) {
          rows.push({
            position_id: 'pos-asset-1',
            commitment_sum: '0',
            quantity_sum: '0.00000000',
            cash_sum: '-600000.00000000',
            contributed_sum: '600000.00000000', // 60%
          });
        }
        if (ids.includes('pos-asset-2')) {
          rows.push({
            position_id: 'pos-asset-2',
            commitment_sum: '0',
            quantity_sum: '0.00000000',
            cash_sum: '-400000.00000000',
            contributed_sum: '400000.00000000', // 40%
          });
        }
        return Promise.resolve(rows);
      });

      mockValuationRepo.findLatestByPositionIds.mockResolvedValue([]);
      mockValuationRepo.findLatestByAssetIds.mockResolvedValue([
        {
          asset_id: 'asset-multi',
          market_value: '2000000.00000000', // 2M asset valuation
          price_per_unit: null,
          units_outstanding: null,
          valuation_method: 'fundraise_round',
        },
      ]);
      mockPositionRepo.findByAssetIds.mockResolvedValue([pos1, pos2]); // 2 positions in workspace

      const vals = await service.getPositionValues(workspaceId, [pos1, pos2]);
      // pos1 gets 60% of 2M = 1.2M; pos2 gets 40% of 2M = 800k.
      // Neither receives full 2M, and neither is silently valued at zero.
      expect(vals[0].value).toBe('1200000.00000000');
      expect(vals[0].method).toBe('fundraise_round');
      expect(vals[1].value).toBe('800000.00000000');
      expect(vals[1].method).toBe('fundraise_round');
    });

    it('returns explicit ambiguous result when multiple positions exist without allocation basis (AC 3)', async () => {
      const pos1 = {
        id: 'pos-asset-a',
        asset_id: 'asset-no-basis',
        fund_id: null,
        opened_at: '2026-01-01',
      } as any;
      const pos2 = {
        id: 'pos-asset-b',
        asset_id: 'asset-no-basis',
        fund_id: null,
        opened_at: '2026-01-01',
      } as any;

      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-asset-a',
          commitment_sum: '0',
          quantity_sum: '0',
          cash_sum: '0',
          contributed_sum: '0',
        },
        {
          position_id: 'pos-asset-b',
          commitment_sum: '0',
          quantity_sum: '0',
          cash_sum: '0',
          contributed_sum: '0',
        },
      ]);

      mockValuationRepo.findLatestByPositionIds.mockResolvedValue([]);
      mockValuationRepo.findLatestByAssetIds.mockResolvedValue([
        {
          asset_id: 'asset-no-basis',
          market_value: '2000000.00000000',
          valuation_method: 'other',
        },
      ]);
      mockPositionRepo.findByAssetIds.mockResolvedValue([pos1, pos2]);

      const vals = await service.getPositionValues(workspaceId, [pos1, pos2]);
      expect(vals[0].value).toBe('0.00000000');
      expect(vals[0].method).toBe('ambiguous');
      expect(vals[1].value).toBe('0.00000000');
      expect(vals[1].method).toBe('ambiguous');
    });

    it('values intended position via position-level mark even when asset has multiple positions (AC 4)', async () => {
      const pos1 = {
        id: 'pos-with-cas',
        asset_id: 'asset-multi',
        fund_id: null,
      } as any;
      const pos2 = {
        id: 'pos-without-cas',
        asset_id: 'asset-multi',
        fund_id: null,
      } as any;

      mockLedgerRepo.sumDeltasByPositionIds.mockImplementation((_ws: string, ids: string[]) => {
        const rows: any[] = [];
        if (ids.includes('pos-with-cas')) {
          rows.push({
            position_id: 'pos-with-cas',
            commitment_sum: '0',
            quantity_sum: '0',
            cash_sum: '-500000',
            contributed_sum: '500000',
          });
        }
        if (ids.includes('pos-without-cas')) {
          rows.push({
            position_id: 'pos-without-cas',
            commitment_sum: '0',
            quantity_sum: '0',
            cash_sum: '-500000',
            contributed_sum: '500000',
          });
        }
        return Promise.resolve(rows);
      });

      mockValuationRepo.findLatestByPositionIds.mockImplementation((_ws: string, ids: string[]) => {
        if (ids.includes('pos-with-cas')) {
          return Promise.resolve([
            {
              position_id: 'pos-with-cas',
              market_value: '1500000.00000000',
              valuation_method: 'capital_account_statement',
            },
          ]);
        }
        return Promise.resolve([]);
      });

      mockValuationRepo.findLatestByAssetIds.mockResolvedValue([
        {
          asset_id: 'asset-multi',
          market_value: '2000000.00000000',
          valuation_method: 'fundraise_round',
        },
      ]);
      mockPositionRepo.findByAssetIds.mockResolvedValue([pos1, pos2]);

      const [val1] = await service.getPositionValues(workspaceId, [pos1]);
      expect(val1.value).toBe('1500000.00000000');
      expect(val1.method).toBe('capital_account_statement');
    });

    it('enforces opened_at and first economic entry cutoff (AC 5)', async () => {
      const posFuture = {
        id: 'pos-future',
        asset_id: 'asset-1',
        fund_id: null,
        opened_at: '2026-06-01',
      } as any;

      mockPositionRepo.findByAssetIds.mockResolvedValue([posFuture]);
      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-future',
          commitment_sum: '0',
          quantity_sum: '0',
          cash_sum: '0',
          contributed_sum: '0',
        },
      ]);
      mockValuationRepo.findLatestByAssetIds.mockResolvedValue([
        {
          asset_id: 'asset-1',
          market_value: '5000000.00000000',
          valuation_method: 'other',
        },
      ]);

      // Querying as of 2026-05-31 (before opened_at 2026-06-01) -> returns 0 and null method
      const [preVal] = await service.getPositionValues(workspaceId, [posFuture], '2026-05-31');
      expect(preVal.value).toBe('0.00000000');
      expect(preVal.method).toBeNull();

      // Querying as of 2026-06-01 (on/after opened_at) -> eligible and valued
      const [postVal] = await service.getPositionValues(workspaceId, [posFuture], '2026-06-01');
      expect(postVal.value).toBe('5000000.00000000');
      expect(postVal.method).toBe('other');
    });

    it('values fund position via pro-rata NAV on units basis', async () => {
      const targetFund = {
        id: 'fund-target-units',
        workspace_id: workspaceId,
        ownership_basis: 'units',
      };
      const subjectPos = {
        id: 'pos-f-1',
        fund_id: 'fund-target-units',
        asset_id: null,
      } as any;
      const otherPos = {
        id: 'pos-f-2',
        fund_id: 'fund-target-units',
        asset_id: null,
      } as any;

      mockFundRepo.findByIds.mockResolvedValue([targetFund]);
      mockPositionRepo.findByFundIds.mockResolvedValue([subjectPos, otherPos]);

      mockLedgerRepo.sumDeltasByPositionIds.mockImplementation((_ws: string, ids: string[]) => {
        return Promise.resolve([
          {
            position_id: 'pos-f-1',
            commitment_sum: '0',
            quantity_sum: '3000.00000000',
            cash_sum: '-30000',
            contributed_sum: '30000',
          },
          {
            position_id: 'pos-f-2',
            commitment_sum: '0',
            quantity_sum: '7000.00000000',
            cash_sum: '-70000',
            contributed_sum: '70000',
          },
        ]);
      });

      mockValuationRepo.findLatestByPositionIds.mockResolvedValue([]);
      mockValuationRepo.findLatestByFundIds.mockResolvedValue([
        {
          fund_id: 'fund-target-units',
          net_value: '500000.00000000', // total fund NAV = 500k
          valuation_method: 'appraisal',
        },
      ]);

      const [val] = await service.getPositionValues(workspaceId, [subjectPos]);
      // Total units = 3000 + 7000 = 10000. Subject pos has 3000 -> 30% of 500k = 150k
      expect(val.value).toBe('150000.00000000');
      expect(val.method).toBe('appraisal');
    });

    it('values fund position via pro-rata NAV on commitment basis', async () => {
      const targetFund = {
        id: 'fund-target-comm',
        workspace_id: workspaceId,
        ownership_basis: 'commitment',
      };
      const subjectPos = {
        id: 'pos-c-1',
        fund_id: 'fund-target-comm',
        asset_id: null,
      } as any;
      const otherPos = {
        id: 'pos-c-2',
        fund_id: 'fund-target-comm',
        asset_id: null,
      } as any;

      mockFundRepo.findByIds.mockResolvedValue([targetFund]);
      mockPositionRepo.findByFundIds.mockResolvedValue([subjectPos, otherPos]);

      mockLedgerRepo.sumDeltasByPositionIds.mockImplementation((_ws: string, ids: string[]) => {
        return Promise.resolve([
          {
            position_id: 'pos-c-1',
            commitment_sum: '250000.00000000',
            quantity_sum: '0',
            cash_sum: '-100000',
            contributed_sum: '100000',
          },
          {
            position_id: 'pos-c-2',
            commitment_sum: '750000.00000000',
            quantity_sum: '0',
            cash_sum: '-300000',
            contributed_sum: '300000',
          },
        ]);
      });

      mockValuationRepo.findLatestByPositionIds.mockResolvedValue([]);
      mockValuationRepo.findLatestByFundIds.mockResolvedValue([
        {
          fund_id: 'fund-target-comm',
          net_value: '2000000.00000000', // total fund NAV = 2M
          valuation_method: 'capital_account_statement',
        },
      ]);

      const [val] = await service.getPositionValues(workspaceId, [subjectPos]);
      // Total committed = 250k + 750k = 1M. Subject pos has 250k -> 25% of 2M = 500k
      expect(val.value).toBe('500000.00000000');
      expect(val.method).toBe('capital_account_statement');
    });

    it('values fund position via pro-rata NAV on capital_account basis', async () => {
      const targetFund = {
        id: 'fund-target-cap',
        workspace_id: workspaceId,
        ownership_basis: 'capital_account',
      };
      const subjectPos = {
        id: 'pos-cap-1',
        fund_id: 'fund-target-cap',
        asset_id: null,
      } as any;
      const otherPos = {
        id: 'pos-cap-2',
        fund_id: 'fund-target-cap',
        asset_id: null,
      } as any;

      mockFundRepo.findByIds.mockResolvedValue([targetFund]);
      mockPositionRepo.findByFundIds.mockResolvedValue([subjectPos, otherPos]);

      mockLedgerRepo.sumDeltasByPositionIds.mockImplementation((_ws: string, ids: string[]) => {
        return Promise.resolve([
          {
            position_id: 'pos-cap-1',
            commitment_sum: '500000',
            quantity_sum: '0',
            cash_sum: '-200000.00000000',
            contributed_sum: '200000.00000000',
          },
          {
            position_id: 'pos-cap-2',
            commitment_sum: '500000',
            quantity_sum: '0',
            cash_sum: '-600000.00000000',
            contributed_sum: '600000.00000000',
          },
        ]);
      });

      mockValuationRepo.findLatestByPositionIds.mockResolvedValue([]);
      mockValuationRepo.findLatestByFundIds.mockResolvedValue([
        {
          fund_id: 'fund-target-cap',
          net_value: '1600000.00000000', // total fund NAV = 1.6M
          valuation_method: 'capital_account_statement',
        },
      ]);

      const [val] = await service.getPositionValues(workspaceId, [subjectPos]);
      // Total contributed = 200k + 600k = 800k. Subject pos contributed 200k -> 25% of 1.6M = 400k
      expect(val.value).toBe('400000.00000000');
      expect(val.method).toBe('capital_account_statement');
    });

    it('returns zero value and null method when fund valuation is missing (no fake at-cost)', async () => {
      const targetFund = {
        id: 'fund-target-missing',
        workspace_id: workspaceId,
        ownership_basis: 'commitment',
      };
      const subjectPos = {
        id: 'pos-m-1',
        fund_id: 'fund-target-missing',
        asset_id: null,
      } as any;

      mockFundRepo.findByIds.mockResolvedValue([targetFund]);
      mockPositionRepo.findByFundIds.mockResolvedValue([subjectPos]);
      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-m-1',
          commitment_sum: '1000000',
          quantity_sum: '0',
          cash_sum: '-500000',
          contributed_sum: '500000',
        },
      ]);

      mockValuationRepo.findLatestByPositionIds.mockResolvedValue([]);
      mockValuationRepo.findLatestByFundIds.mockResolvedValue([]); // No fund mark

      const [val] = await service.getPositionValues(workspaceId, [subjectPos]);
      expect(val.value).toBe('0.00000000');
      expect(val.method).toBeNull();
    });

    it('batches multiple target fund lookups into a single fundRepo.findByIds call and never calls fundRepo.findById inside getPositionValues', async () => {
      const fundA = {
        id: 'fund-A',
        workspace_id: workspaceId,
        ownership_basis: 'commitment',
      };
      const fundB = {
        id: 'fund-B',
        workspace_id: workspaceId,
        ownership_basis: 'units',
      };

      const posA = { id: 'pos-f-A', fund_id: 'fund-A', asset_id: null } as any;
      const posB = { id: 'pos-f-B', fund_id: 'fund-B', asset_id: null } as any;

      mockFundRepo.findByIds.mockResolvedValue([fundA, fundB]);
      mockPositionRepo.findByFundIds.mockResolvedValue([posA, posB]);

      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-f-A',
          commitment_sum: '1000000',
          quantity_sum: '0',
          cash_sum: '-500000',
          contributed_sum: '500000',
        },
        {
          position_id: 'pos-f-B',
          commitment_sum: '0',
          quantity_sum: '1000',
          cash_sum: '-10000',
          contributed_sum: '10000',
        },
      ]);

      mockValuationRepo.findLatestByFundIds.mockResolvedValue([
        { fund_id: 'fund-A', net_value: '2000000.00000000', valuation_method: 'appraisal' },
        { fund_id: 'fund-B', net_value: '50000.00000000', valuation_method: 'appraisal' },
      ]);

      const vals = await service.getPositionValues(workspaceId, [posA, posB]);

      expect(vals).toHaveLength(2);
      // Verify exactly 1 call to findByIds with all fund IDs
      expect(mockFundRepo.findByIds).toHaveBeenCalledTimes(1);
      expect(mockFundRepo.findByIds).toHaveBeenCalledWith(
        workspaceId,
        ['fund-A', 'fund-B'],
        undefined,
      );
      // Verify findById was NOT called inside getPositionValues
      expect(mockFundRepo.findById).not.toHaveBeenCalled();
    });
  });

  describe('getFundRollup with a managed fund as LP (MB-569)', () => {
    it('includes the fund-held position of another managed fund in the LP registry and ownership', async () => {
      mockFundRepo.findById.mockResolvedValue({
        id: 'f-hua',
        workspace_id: workspaceId,
        name: '淮安熙和',
        ownership_basis: 'commitment',
      });
      mockPositionRepo.findByFundIds.mockResolvedValue([
        { id: 'pos-out', holder_investor_id: 'inv-jinhu', holder_fund_id: null, fund_id: 'f-hua' },
        { id: 'pos-yue-hua', holder_investor_id: null, holder_fund_id: 'f-yue', fund_id: 'f-hua' },
      ]);
      mockPositionRepo.findByHolderFundIds.mockResolvedValue([]);
      mockLedgerRepo.sumDeltasByPositionIds.mockImplementation((_ws: string, ids: string[]) =>
        Promise.resolve(
          ids.includes('pos-yue-hua')
            ? [
                { position_id: 'pos-out', commitment_sum: '75000000.00000000', quantity_sum: '0.00000000', cash_sum: '-14000000.00000000', contributed_sum: '14000000.00000000' },
                { position_id: 'pos-yue-hua', commitment_sum: '95500000.00000000', quantity_sum: '0.00000000', cash_sum: '-29000000.00000000', contributed_sum: '29000000.00000000' },
              ]
            : [],
        ),
      );

      const rollup = await service.getFundRollup(workspaceId, 'f-hua');

      expect(rollup.lp_registry.total_committed).toBe('170500000.00000000');
      const fundLp = rollup.lp_registry.lps.find((l) => l.position_id === 'pos-yue-hua')!;
      expect(fundLp.holder_fund_id).toBe('f-yue');
      expect(fundLp.ownership_percentage).toBe(
        (Math.round((95_500_000 / 170_500_000) * 100 * 1e6) / 1e6).toFixed(6),
      );
    });
  });

  describe('getFundRollup without N+1', () => {
    it('rolls up LP registry by commitment basis and computes portfolio valuation', async () => {
      const fund = {
        id: 'fund-1',
        workspace_id: workspaceId,
        name: 'Growth Fund I',
        ownership_basis: 'commitment',
      };

      const lpPositions = [
        { id: 'pos-lp-1', holder_investor_id: 'inv-1', holder_fund_id: null, fund_id: 'fund-1' },
        { id: 'pos-lp-2', holder_investor_id: 'inv-2', holder_fund_id: null, fund_id: 'fund-1' },
      ];

      const portfolioPositions = [
        { id: 'pos-port-1', asset_id: 'asset-1', fund_id: null },
      ];

      mockFundRepo.findById.mockResolvedValue(fund);
      mockPositionRepo.findByFundIds.mockResolvedValue(lpPositions);
      mockPositionRepo.findByHolderFundIds.mockResolvedValue(portfolioPositions);

      mockLedgerRepo.sumDeltasByPositionIds.mockImplementation((_ws: string, ids: string[]) => {
        if (ids.includes('pos-lp-1')) {
          return Promise.resolve([
            {
              position_id: 'pos-lp-1',
              commitment_sum: '60000000.00000000',
              quantity_sum: '0.00000000',
              cash_sum: '-30000000.00000000',
              contributed_sum: '30000000.00000000',
            },
            {
              position_id: 'pos-lp-2',
              commitment_sum: '40000000.00000000',
              quantity_sum: '0.00000000',
              cash_sum: '-20000000.00000000',
              contributed_sum: '20000000.00000000',
            },
          ]);
        }
        if (ids.includes('pos-port-1')) {
          return Promise.resolve([
            {
              position_id: 'pos-port-1',
              commitment_sum: '0.00000000',
              quantity_sum: '1000.00000000',
              cash_sum: '-10000000.00000000',
              contributed_sum: '10000000.00000000',
            },
          ]);
        }
        return Promise.resolve([]);
      });

      mockValuationRepo.findLatestByAssetIds.mockResolvedValue([
        {
          asset_id: 'asset-1',
          price_per_unit: '15000.00000000', // 1000 units * 15000 = 15,000,000
          valuation_method: 'fundraise_round',
        },
      ]);

      const rollup = await service.getFundRollup(workspaceId, 'fund-1');

      // Assert LP registry rollup
      expect(rollup.lp_registry.total_committed).toBe('100000000.00000000');
      expect(rollup.lp_registry.total_contributed).toBe('50000000.00000000');
      expect(rollup.lp_registry.total_unfunded).toBe('50000000.00000000');

      // LP ownership % by commitment
      const lp1 = rollup.lp_registry.lps.find((l) => l.position_id === 'pos-lp-1')!;
      const lp2 = rollup.lp_registry.lps.find((l) => l.position_id === 'pos-lp-2')!;
      expect(lp1.ownership_percentage).toBe('60.000000');
      expect(lp2.ownership_percentage).toBe('40.000000');

      // Assert portfolio rollup
      expect(rollup.portfolio.total_invested).toBe('10000000.00000000');
      expect(rollup.portfolio.total_value).toBe('15000000.00000000');
      expect(rollup.portfolio.positions[0].current_value).toBe('15000000.00000000');
      expect(rollup.portfolio.positions[0].valuation_method).toBe('fundraise_round');

      // Assert N+1 guard: findByFundIds and findByHolderFundIds called once each
      expect(mockPositionRepo.findByFundIds).toHaveBeenCalledTimes(1);
      expect(mockPositionRepo.findByHolderFundIds).toHaveBeenCalledTimes(1);
    });

    it('reports invested capital as cumulative contributed capital (100) rather than net cash (40) after a buy of 100 and distribution of 60', async () => {
      const fund = {
        id: 'fund-1',
        workspace_id: workspaceId,
        name: 'Growth Fund I',
        ownership_basis: 'commitment',
      };

      const lpPositions = [
        { id: 'pos-lp-1', holder_investor_id: 'inv-1', holder_fund_id: null, fund_id: 'fund-1' },
      ];

      const portfolioPositions = [
        { id: 'pos-port-1', asset_id: 'asset-1', fund_id: null },
      ];

      mockFundRepo.findById.mockResolvedValue(fund);
      mockPositionRepo.findByFundIds.mockResolvedValue(lpPositions);
      mockPositionRepo.findByHolderFundIds.mockResolvedValue(portfolioPositions);

      mockLedgerRepo.sumDeltasByPositionIds.mockImplementation((_ws: string, ids: string[]) => {
        if (ids.includes('pos-lp-1')) {
          return Promise.resolve([
            {
              position_id: 'pos-lp-1',
              commitment_sum: '100.00000000',
              quantity_sum: '0.00000000',
              cash_sum: '-100.00000000',
              contributed_sum: '100.00000000',
            },
          ]);
        }
        if (ids.includes('pos-port-1')) {
          // Buy 100 (cash_delta -100) + Distribution/Sell 60 (cash_delta +60)
          // cash_sum is -40, but cumulative contributed_sum is 100
          return Promise.resolve([
            {
              position_id: 'pos-port-1',
              commitment_sum: '0.00000000',
              quantity_sum: '50.00000000',
              cash_sum: '-40.00000000',
              contributed_sum: '100.00000000',
            },
          ]);
        }
        return Promise.resolve([]);
      });

      mockValuationRepo.findLatestByAssetIds.mockResolvedValue([
        {
          asset_id: 'asset-1',
          price_per_unit: '2.00000000', // 50 units * 2 = 100
          valuation_method: 'at_cost',
        },
      ]);

      const rollup = await service.getFundRollup(workspaceId, 'fund-1');

      // Invested capital must be cumulative contributed capital (100), not net cash (40)
      expect(rollup.portfolio.positions[0].invested_capital).toBe('100.00000000');
      expect(rollup.portfolio.total_invested).toBe('100.00000000');
      expect(rollup.portfolio.total_value).toBe('100.00000000');
    });

    it('adds retained sell proceeds exactly once to fund total_value as cash-equivalent value and excludes from LP distributions without creating cash positions', async () => {
      const fund: Tables<'fl_funds'> = {
        id: 'fund-1',
        workspace_id: workspaceId,
        name: 'Growth Fund I',
        ownership_basis: 'commitment',
        base_currency: 'USD',
        status: 'investing',
      } as Tables<'fl_funds'>;

      const lpPositions: Tables<'fl_positions'>[] = [
        {
          id: 'pos-lp-1',
          workspace_id: workspaceId,
          holder_investor_id: 'inv-1',
          holder_fund_id: null,
          fund_id: 'fund-1',
          asset_id: null,
          status: 'open',
        } as Tables<'fl_positions'>,
      ];

      const portfolioPositions: Tables<'fl_positions'>[] = [
        {
          id: 'pos-port-1',
          workspace_id: workspaceId,
          holder_investor_id: null,
          holder_fund_id: 'fund-1',
          fund_id: null,
          asset_id: 'asset-1',
          status: 'open',
        } as Tables<'fl_positions'>,
        {
          id: 'pos-cash-1',
          workspace_id: workspaceId,
          holder_investor_id: null,
          holder_fund_id: 'fund-1',
          fund_id: null,
          asset_id: 'asset-cash-usd',
          status: 'open',
        } as Tables<'fl_positions'>,
      ];

      mockFundRepo.findById.mockResolvedValue(fund);
      mockPositionRepo.findByFundIds.mockResolvedValue(lpPositions);
      mockPositionRepo.findByHolderFundIds.mockResolvedValue(portfolioPositions);
      mockPositionRepo.findByIds = vi.fn().mockImplementation((_ws: string, ids: string[]) => {
        return Promise.resolve(
          ids.map((id) => ({
            id,
            workspace_id: workspaceId,
            holder_fund_id: 'fund-1',
            asset_id: id === 'pos-cash-1' ? 'asset-cash-usd' : 'asset-1',
            fund_id: null,
            status: 'open',
          })),
        );
      });
      mockAssetRepo.findByIds = vi.fn().mockResolvedValue([
        { id: 'asset-1', asset_kind: 'equity' },
        { id: 'asset-cash-usd', asset_kind: 'cash' },
      ]);

      // Scenario:
      // Asset 1 bought for 100, partially sold for 60 retained in fund (cash_in_fund)
      // Remaining 50 shares marked at $1/share -> position current_value = 50
      mockLedgerRepo.sumDeltasByPositionIds.mockImplementation((_ws: string, ids: string[]) => {
        const rows: any[] = [];
        if (ids.includes('pos-lp-1')) {
          rows.push({
            position_id: 'pos-lp-1',
            commitment_sum: '100.00000000',
            quantity_sum: '0.00000000',
            cash_sum: '-100.00000000',
            contributed_sum: '100.00000000',
            retained_proceeds_sum: '0.00000000',
          });
        }
        if (ids.includes('pos-port-1')) {
          rows.push({
            position_id: 'pos-port-1',
            commitment_sum: '0.00000000',
            quantity_sum: '50.00000000',
            cash_sum: '-40.00000000',
            contributed_sum: '100.00000000',
            retained_proceeds_sum: '60.00000000',
          });
        }
        if (ids.includes('pos-cash-1')) {
          rows.push({
            position_id: 'pos-cash-1',
            commitment_sum: '0.00000000',
            quantity_sum: '0.00000000',
            cash_sum: '60.00000000',
            contributed_sum: '0.00000000',
            retained_proceeds_sum: '0.00000000',
          });
        }
        return Promise.resolve(rows);
      });

      mockValuationRepo.findLatestByAssetIds.mockResolvedValue([
        {
          asset_id: 'asset-1',
          price_per_unit: '1.00000000', // 50 shares * 1 = 50
          valuation_method: 'at_cost',
        },
      ]);

      const rollup = await service.getFundRollup(workspaceId, 'fund-1');

      // 1. Position-level metrics (cash positions excluded from portfolio records):
      expect(rollup.portfolio.positions).toHaveLength(1);
      expect(rollup.portfolio.positions[0].position_id).toBe('pos-port-1');
      expect(rollup.portfolio.positions[0].current_value).toBe('50.00000000'); // remaining shares mark only
      expect(rollup.portfolio.positions[0].invested_capital).toBe('100.00000000');

      // 2. Fund total_value adds cash position balance ($60) exactly once to position values ($50) = $110
      expect(rollup.cash_balance).toBe('60.00000000');
      expect(rollup.portfolio.total_value).toBe('110.00000000');
      expect(rollup.portfolio.total_invested).toBe('100.00000000');

      // 3. LP distribution registry excludes retained proceeds (total_distributed remains 0)
      expect(rollup.lp_registry.total_distributed).toBe('0.00000000');

      // 4. No synthetic cash position created in positions array
      const hasCashPosition = rollup.portfolio.positions.some((p) => p.asset_id === null && p.fund_id === null);
      expect(hasCashPosition).toBe(false);
    });

    it('respects asOfDate cutoff for retained sell proceeds and positions', async () => {
      const fund: Tables<'fl_funds'> = {
        id: 'fund-1',
        workspace_id: workspaceId,
        name: 'Growth Fund I',
        ownership_basis: 'commitment',
        base_currency: 'USD',
        status: 'investing',
      } as Tables<'fl_funds'>;

      const lpPositions: Tables<'fl_positions'>[] = [
        {
          id: 'pos-lp-1',
          workspace_id: workspaceId,
          holder_investor_id: 'inv-1',
          holder_fund_id: null,
          fund_id: 'fund-1',
          asset_id: null,
          status: 'open',
        } as Tables<'fl_positions'>,
      ];

      const portfolioPositions: Tables<'fl_positions'>[] = [
        {
          id: 'pos-port-1',
          workspace_id: workspaceId,
          holder_investor_id: null,
          holder_fund_id: 'fund-1',
          fund_id: null,
          asset_id: 'asset-1',
          status: 'open',
        } as Tables<'fl_positions'>,
        {
          id: 'pos-cash-1',
          workspace_id: workspaceId,
          holder_investor_id: null,
          holder_fund_id: 'fund-1',
          fund_id: null,
          asset_id: 'asset-cash-usd',
          status: 'open',
        } as Tables<'fl_positions'>,
      ];

      mockFundRepo.findById.mockResolvedValue(fund);
      mockPositionRepo.findByFundIds.mockResolvedValue(lpPositions);
      mockPositionRepo.findByHolderFundIds.mockResolvedValue(portfolioPositions);
      mockPositionRepo.findByIds = vi.fn().mockImplementation((_ws: string, ids: string[]) => {
        return Promise.resolve(
          ids.map((id) => ({
            id,
            workspace_id: workspaceId,
            holder_fund_id: 'fund-1',
            asset_id: id === 'pos-cash-1' ? 'asset-cash-usd' : 'asset-1',
            fund_id: null,
            status: 'open',
          })),
        );
      });
      mockAssetRepo.findByIds = vi.fn().mockResolvedValue([
        { id: 'asset-1', asset_kind: 'equity' },
        { id: 'asset-cash-usd', asset_kind: 'cash' },
      ]);

      mockLedgerRepo.sumDeltasByPositionIds.mockImplementation((_ws: string, ids: string[], asOf?: string | null) => {
        const rows: any[] = [];
        if (ids.includes('pos-lp-1')) {
          rows.push({
            position_id: 'pos-lp-1',
            commitment_sum: '100.00000000',
            quantity_sum: '0.00000000',
            cash_sum: '-100.00000000',
            contributed_sum: '100.00000000',
            retained_proceeds_sum: '0.00000000',
          });
        }
        if (asOf === '2026-05-31') {
          // Before sell date
          if (ids.includes('pos-port-1')) {
            rows.push({
              position_id: 'pos-port-1',
              commitment_sum: '0.00000000',
              quantity_sum: '100.00000000',
              cash_sum: '-100.00000000',
              contributed_sum: '100.00000000',
              retained_proceeds_sum: '0.00000000',
            });
          }
          if (ids.includes('pos-cash-1')) {
            rows.push({
              position_id: 'pos-cash-1',
              commitment_sum: '0.00000000',
              quantity_sum: '0.00000000',
              cash_sum: '0.00000000',
              contributed_sum: '0.00000000',
              retained_proceeds_sum: '0.00000000',
            });
          }
        } else {
          // After sell date (2026-06-30)
          if (ids.includes('pos-port-1')) {
            rows.push({
              position_id: 'pos-port-1',
              commitment_sum: '0.00000000',
              quantity_sum: '50.00000000',
              cash_sum: '-40.00000000',
              contributed_sum: '100.00000000',
              retained_proceeds_sum: '60.00000000',
            });
          }
          if (ids.includes('pos-cash-1')) {
            rows.push({
              position_id: 'pos-cash-1',
              commitment_sum: '0.00000000',
              quantity_sum: '0.00000000',
              cash_sum: '60.00000000',
              contributed_sum: '0.00000000',
              retained_proceeds_sum: '0.00000000',
            });
          }
        }
        return Promise.resolve(rows);
      });

      mockValuationRepo.findLatestByAssetIds.mockImplementation((_ws: string, _ids: string[], asOf?: string | null) => {
        if (asOf === '2026-05-31') {
          return Promise.resolve([
            { asset_id: 'asset-1', price_per_unit: '1.00000000', valuation_method: 'at_cost' },
          ]);
        }
        return Promise.resolve([
          { asset_id: 'asset-1', price_per_unit: '1.00000000', valuation_method: 'at_cost' },
        ]);
      });

      const rollupPre = await service.getFundRollup(workspaceId, 'fund-1', '2026-05-31');
      expect(rollupPre.portfolio.total_value).toBe('100.00000000'); // 100 shares * 1 + 0 cash

      const rollupPost = await service.getFundRollup(workspaceId, 'fund-1', '2026-06-30');
      expect(rollupPost.portfolio.total_value).toBe('110.00000000'); // 50 shares * 1 + 60 cash
    });

    it('proves retained proceeds are included in fund total_value while distributed non-retained proceeds are excluded from total_value and included in distributed', async () => {
      const fund: Tables<'fl_funds'> = {
        id: 'fund-1',
        workspace_id: workspaceId,
        name: 'Growth Fund I',
        ownership_basis: 'commitment',
        base_currency: 'USD',
        status: 'investing',
      } as Tables<'fl_funds'>;

      const lpPositions: Tables<'fl_positions'>[] = [
        {
          id: 'pos-lp-1',
          workspace_id: workspaceId,
          holder_investor_id: 'inv-1',
          holder_fund_id: null,
          fund_id: 'fund-1',
          asset_id: null,
          status: 'open',
        } as Tables<'fl_positions'>,
      ];

      const portfolioPositions: Tables<'fl_positions'>[] = [
        {
          id: 'pos-port-retained',
          workspace_id: workspaceId,
          holder_investor_id: null,
          holder_fund_id: 'fund-1',
          fund_id: null,
          asset_id: 'asset-retained',
          status: 'open',
        } as Tables<'fl_positions'>,
        {
          id: 'pos-port-distributed',
          workspace_id: workspaceId,
          holder_investor_id: null,
          holder_fund_id: 'fund-1',
          fund_id: null,
          asset_id: 'asset-distributed',
          status: 'open',
        } as Tables<'fl_positions'>,
        {
          id: 'pos-cash-retained',
          workspace_id: workspaceId,
          holder_investor_id: null,
          holder_fund_id: 'fund-1',
          fund_id: null,
          asset_id: 'asset-cash-usd',
          status: 'open',
        } as Tables<'fl_positions'>,
      ];

      mockFundRepo.findById.mockResolvedValue(fund);
      mockPositionRepo.findByFundIds.mockResolvedValue(lpPositions);
      mockPositionRepo.findByHolderFundIds.mockResolvedValue(portfolioPositions);
      mockPositionRepo.findByIds = vi.fn().mockImplementation((_ws: string, ids: string[]) => {
        return Promise.resolve(
          ids.map((id) => ({
            id,
            workspace_id: workspaceId,
            holder_fund_id: 'fund-1',
            asset_id: id === 'pos-cash-retained' ? 'asset-cash-usd' : id === 'pos-port-retained' ? 'asset-retained' : 'asset-distributed',
            fund_id: null,
            status: 'open',
          })),
        );
      });
      mockAssetRepo.findByIds = vi.fn().mockResolvedValue([
        { id: 'asset-retained', asset_kind: 'equity' },
        { id: 'asset-distributed', asset_kind: 'equity' },
        { id: 'asset-cash-usd', asset_kind: 'cash' },
      ]);

      // Asset 1 (retained): bought for 1000, sold 400 with cash_in_fund (retained_proceeds_sum = 400). FMV = 0. Cash position has cash_sum = 400.
      // Asset 2 (distributed): bought for 500, sold 200 distributed to LPs (retained_proceeds_sum = 0, cash_sum = -300, contributed_sum = 500). FMV = 300.
      mockLedgerRepo.sumDeltasByPositionIds.mockImplementation((_ws: string, ids: string[]) => {
        const rows: Array<{
          position_id: string;
          commitment_sum: string;
          quantity_sum: string;
          cash_sum: string;
          contributed_sum: string;
          retained_proceeds_sum: string;
        }> = [];

        if (ids.includes('pos-lp-1')) {
          rows.push({
            position_id: 'pos-lp-1',
            commitment_sum: '1500.00000000',
            quantity_sum: '0.00000000',
            cash_sum: '-1300.00000000', // 1500 drawn - 200 distributed
            contributed_sum: '1500.00000000',
            retained_proceeds_sum: '0.00000000',
          });
        }
        if (ids.includes('pos-port-retained')) {
          rows.push({
            position_id: 'pos-port-retained',
            commitment_sum: '0.00000000',
            quantity_sum: '0.00000000',
            cash_sum: '-600.00000000', // -1000 + 400
            contributed_sum: '1000.00000000',
            retained_proceeds_sum: '400.00000000',
          });
        }
        if (ids.includes('pos-port-distributed')) {
          rows.push({
            position_id: 'pos-port-distributed',
            commitment_sum: '0.00000000',
            quantity_sum: '30.00000000',
            cash_sum: '-300.00000000', // -500 + 200
            contributed_sum: '500.00000000',
            retained_proceeds_sum: '0.00000000',
          });
        }
        if (ids.includes('pos-cash-retained')) {
          rows.push({
            position_id: 'pos-cash-retained',
            commitment_sum: '0.00000000',
            quantity_sum: '0.00000000',
            cash_sum: '400.00000000',
            contributed_sum: '0.00000000',
            retained_proceeds_sum: '0.00000000',
          });
        }
        return Promise.resolve(rows);
      });

      mockValuationRepo.findLatestByAssetIds.mockImplementation((_ws: string, ids: string[]) => {
        const vals: Array<{ asset_id: string; price_per_unit: string; valuation_method: string }> = [];
        if (ids.includes('asset-retained')) {
          vals.push({ asset_id: 'asset-retained', price_per_unit: '0.00000000', valuation_method: 'at_cost' });
        }
        if (ids.includes('asset-distributed')) {
          vals.push({ asset_id: 'asset-distributed', price_per_unit: '10.00000000', valuation_method: 'at_cost' }); // 30 * 10 = 300
        }
        return Promise.resolve(vals);
      });

      const rollup = await service.getFundRollup(workspaceId, 'fund-1');

      // 1. Portfolio total value includes asset FMV ($300) + cash position balance ($400) = $700.
      // Non-retained proceeds ($200) are NOT added to portfolio total_value.
      expect(rollup.cash_balance).toBe('400.00000000');
      expect(rollup.portfolio.total_value).toBe('700.00000000');
      expect(rollup.portfolio.total_invested).toBe('1500.00000000');

      // 2. LP registry total_distributed contains only the distributed proceeds ($200), not retained ($400)
      expect(rollup.lp_registry.total_distributed).toBe('200.00000000');
      expect(rollup.lp_registry.total_contributed).toBe('1500.00000000');
    });

    it('Row 1: cash position balance always returns distributed = 0.00000000', async () => {
      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValueOnce([
        {
          position_id: 'pos-cash-1',
          asset_kind: 'cash',
          commitment_sum: '0.00000000',
          quantity_sum: '0.00000000',
          cash_sum: '500000.00000000',
          contributed_sum: '0.00000000',
          retained_proceeds_sum: '0.00000000',
        },
      ]);

      const [bal] = await service.getPositionBalances(workspaceId, ['pos-cash-1']);
      expect(bal.distributed).toBe('0.00000000');
      expect(bal.distributed_capital).toBe('0.00000000');
      expect(bal.cash_total).toBe('500000.00000000');
      expect(bal.asset_kind).toBe('cash');
    });

    it('Row 2: cash positions value at par (cash_par), bypassing asset valuation precedence', async () => {
      mockPositionRepo.findByIds = vi.fn().mockResolvedValue([
        {
          id: 'pos-cash-1',
          workspace_id: workspaceId,
          asset_id: 'asset-cash-usd',
          fund_id: null,
          holder_fund_id: 'fund-1',
          status: 'open',
          opened_at: '2025-01-01',
        },
      ]);
      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-cash-1',
          asset_kind: 'cash',
          commitment_sum: '0.00000000',
          quantity_sum: '0.00000000',
          cash_sum: '750000.00000000',
          contributed_sum: '0.00000000',
          retained_proceeds_sum: '0.00000000',
        },
      ]);
      mockAssetRepo.findByIds = vi.fn().mockResolvedValue([
        {
          id: 'asset-cash-usd',
          asset_kind: 'cash',
        },
      ]);
      // Explicit asset valuation mark that would otherwise take precedence if not cash
      mockValuationRepo.findLatestByAssetIds.mockResolvedValueOnce([
        {
          asset_id: 'asset-cash-usd',
          market_value: '9999999.00000000',
          valuation_method: 'at_cost',
        },
      ]);

      const [val] = await service.getPositionValues(workspaceId, [
        {
          id: 'pos-cash-1',
          workspace_id: workspaceId,
          asset_id: 'asset-cash-usd',
          fund_id: null,
          holder_fund_id: 'fund-1',
          status: 'open',
          opened_at: '2025-01-01',
        } as any,
      ]);
      expect(val.value).toBe('750000.00000000');
      expect(val.method).toBe('cash_par');
    });

    it('Row 3: getFundRollup unconditionally includes cash balance and disables retained proceeds (never both)', async () => {
      mockFundRepo.findById.mockResolvedValueOnce({
        id: 'fund-1',
        workspace_id: workspaceId,
        ownership_basis: 'commitment',
        base_currency: 'USD',
      });

      mockPositionRepo.findByFundIds.mockResolvedValueOnce([]);
      mockPositionRepo.findByHolderFundIds.mockResolvedValueOnce([
        {
          id: 'pos-inv-1',
          workspace_id: workspaceId,
          holder_fund_id: 'fund-1',
          asset_id: 'asset-inv-1',
          fund_id: null,
          status: 'open',
        },
        {
          id: 'pos-cash-1',
          workspace_id: workspaceId,
          holder_fund_id: 'fund-1',
          asset_id: 'asset-cash-usd',
          fund_id: null,
          status: 'open',
        },
      ]);

      mockPositionRepo.findByIds = vi.fn().mockImplementation((_ws: string, ids: string[]) => {
        return Promise.resolve(
          ids.map((id) => ({
            id,
            workspace_id: workspaceId,
            holder_fund_id: 'fund-1',
            asset_id: id === 'pos-cash-1' ? 'asset-cash-usd' : 'asset-inv-1',
            fund_id: null,
            status: 'open',
          })),
        );
      });

      mockAssetRepo.findByIds = vi.fn().mockResolvedValue([
        { id: 'asset-inv-1', asset_kind: 'equity' },
        { id: 'asset-cash-usd', asset_kind: 'cash' },
      ]);

      mockLedgerRepo.sumDeltasByPositionIds.mockImplementation((_ws: string, ids: string[]) => {
        const rows: any[] = [];
        if (ids.includes('pos-inv-1')) {
          rows.push({
            position_id: 'pos-inv-1',
            asset_kind: 'equity',
            commitment_sum: '0.00000000',
            quantity_sum: '100.00000000',
            cash_sum: '-1000.00000000',
            contributed_sum: '1000.00000000',
            retained_proceeds_sum: '300.00000000',
          });
        }
        if (ids.includes('pos-cash-1')) {
          rows.push({
            position_id: 'pos-cash-1',
            asset_kind: 'cash',
            commitment_sum: '0.00000000',
            quantity_sum: '0.00000000',
            cash_sum: '450.00000000',
            contributed_sum: '0.00000000',
            retained_proceeds_sum: '0.00000000',
          });
        }
        return Promise.resolve(rows);
      });

      mockValuationRepo.findLatestByAssetIds.mockResolvedValue([
        { asset_id: 'asset-inv-1', price_per_unit: '15.00000000', valuation_method: 'at_cost' },
      ]);

      const rollup = await service.getFundRollup(workspaceId, 'fund-1', '2025-01-01');

      // Retained proceeds display disabled:
      expect(rollup.retained_proceeds).toBe('0.00000000');
      // Cash balance used:
      expect(rollup.cash_balance).toBe('450.00000000');
      // Total value = 1500 (holdings) + 450 (cash) = 1950 (NOT 1500 + 450 + 300 = 2250)
      expect(rollup.portfolio.total_value).toBe('1950.00000000');
      expect(rollup.portfolio.total_invested).toBe('1000.00000000');
    });

    it('does not nominally sum multi-currency cash when pending_fx and returns nullable total_value', async () => {
      mockFundRepo.findById.mockResolvedValue({
        id: 'fund-multi',
        workspace_id: workspaceId,
        name: 'Multi Fund',
        base_currency: 'USD',
      });

      mockPositionRepo.findByFundIds.mockResolvedValue([]);
      mockPositionRepo.findByHolderFundIds.mockResolvedValue([
        {
          id: 'pos-inv-1',
          asset_id: 'asset-inv-1',
          holder_fund_id: 'fund-multi',
        },
        {
          id: 'pos-cash-usd',
          asset_id: 'asset-cash-usd',
          holder_fund_id: 'fund-multi',
        },
        {
          id: 'pos-cash-eur',
          asset_id: 'asset-cash-eur',
          holder_fund_id: 'fund-multi',
        },
      ]);

      mockAssetRepo.findById.mockImplementation((_ws: string, id: string) => {
        if (id === 'asset-cash-usd') return Promise.resolve({ id, asset_kind: 'cash', instrument_terms: { currency: 'USD' } });
        if (id === 'asset-cash-eur') return Promise.resolve({ id, asset_kind: 'cash', instrument_terms: { currency: 'EUR' } });
        return Promise.resolve({ id, asset_kind: 'equity' });
      });

      mockLedgerRepo.sumDeltasByPositionIds.mockImplementation((_ws: string, ids: string[]) => {
        const rows: any[] = [];
        if (ids.includes('pos-inv-1')) {
          rows.push({
            position_id: 'pos-inv-1',
            asset_kind: 'equity',
            commitment_sum: '0.00000000',
            quantity_sum: '100.00000000',
            cash_sum: '0.00000000',
            contributed_sum: '1000.00000000',
            retained_proceeds_sum: '0.00000000',
          });
        }
        if (ids.includes('pos-cash-usd')) {
          rows.push({
            position_id: 'pos-cash-usd',
            asset_kind: 'cash',
            cash_sum: '1000.00000000',
          });
        }
        if (ids.includes('pos-cash-eur')) {
          rows.push({
            position_id: 'pos-cash-eur',
            asset_kind: 'cash',
            cash_sum: '500.00000000',
          });
        }
        return Promise.resolve(rows);
      });

      mockValuationRepo.findLatestByAssetIds.mockResolvedValue([
        { asset_id: 'asset-inv-1', price_per_unit: '15.00000000', valuation_method: 'at_cost' },
      ]);

      const rollup = await service.getFundRollup(workspaceId, 'fund-multi', '2025-01-01');

      expect(rollup.fx_status).toBe('pending_fx');
      expect(rollup.reporting_total_available).toBe(false);
      expect(rollup.total_value_available).toBe(false);
      // Total value and cash balance must be null, never nominal sum (1500 + 1000 + 500 = 3000 is FORBIDDEN)
      expect(rollup.cash_balance).toBeNull();
      expect(rollup.portfolio.total_value).toBeNull();
      expect(rollup.retained_proceeds).toBe('0.00000000');
      // Per-currency cash balances exposed
      expect(rollup.cash_balances).toEqual([
        { currency: 'EUR', amount: '500.00000000' },
        { currency: 'USD', amount: '1000.00000000' },
      ]);
    });

    it('MUST NOT BREAK: getPositionBalances subtracts retained_proceeds_sum for investment positions and forces 0 for cash positions', async () => {
      mockPositionRepo.findByIds = vi.fn().mockImplementation((_ws: string, ids: string[]) => {
        return Promise.resolve(
          ids.map((id) => ({
            id,
            workspace_id: workspaceId,
            holder_fund_id: 'fund-1',
            asset_id: id === 'pos-cash' ? 'asset-cash' : 'asset-equity',
            fund_id: null,
            status: 'open',
          })),
        );
      });

      mockAssetRepo.findByIds = vi.fn().mockResolvedValue([
        { id: 'asset-equity', asset_kind: 'equity' },
        { id: 'asset-cash', asset_kind: 'cash' },
      ]);

      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-equity',
          asset_kind: 'equity',
          commitment_sum: '0.00000000',
          quantity_sum: '10.00000000',
          cash_sum: '500.00000000',
          contributed_sum: '1000.00000000',
          retained_proceeds_sum: '200.00000000',
        },
        {
          position_id: 'pos-cash',
          asset_kind: 'cash',
          commitment_sum: '0.00000000',
          quantity_sum: '0.00000000',
          cash_sum: '400.00000000',
          contributed_sum: '0.00000000',
          retained_proceeds_sum: '0.00000000',
        },
      ]);

      const balances = await service.getPositionBalances(workspaceId, ['pos-equity', 'pos-cash']);

      const equityBal = balances.find((b) => b.position_id === 'pos-equity');
      const cashBal = balances.find((b) => b.position_id === 'pos-cash');

      // distributed = max(0, 500 + 1000 - 200) = 1300
      expect(equityBal?.distributed).toBe('1300.00000000');
      expect(equityBal?.retained_proceeds).toBe('200.00000000');

      // Cash position distributed must remain 0 to not inflate DPI
      expect(cashBal?.distributed).toBe('0.00000000');
      expect(cashBal?.cash_total).toBe('400.00000000');
    });
  });
});
