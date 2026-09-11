import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/repositories';
import {
  InvalidCurrencyError,
  InvalidEntryShapeError,
  InvalidValuationTargetError,
  WorkspaceMismatchError,
} from './flErrors';
import { FlValuationService } from './flValuationService';

describe('FlValuationService', () => {
  let mockDb: any;
  let mockValuationRepo: any;
  let mockAssetRepo: any;
  let mockFundRepo: any;
  let mockPositionRepo: any;
  let mockSourceRecordRepo: any;
  let service: FlValuationService;

  const workspaceId = 'ws-val-1';
  const sentinelExecutor = { __sentinel: 'tx-val-sentinel' } as unknown as DbClient;

  beforeEach(() => {
    mockDb = {
      transaction: vi.fn(async (cb: any) => cb(mockDb)),
    };
    mockValuationRepo = {
      create: vi.fn().mockImplementation((data: any) => Promise.resolve({ id: data.id ?? 'val-1', ...data })),
      findById: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockImplementation((id: any, data: any) => Promise.resolve({ id, ...data })),
      delete: vi.fn().mockResolvedValue(undefined),
      findSeriesByTarget: vi.fn().mockResolvedValue([]),
      findLatestByAssetIds: vi.fn().mockResolvedValue([]),
      findLatestByFundIds: vi.fn().mockResolvedValue([]),
      findLatestByPositionIds: vi.fn().mockResolvedValue([]),
    };
    mockAssetRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'asset-1', workspace_id: workspaceId }),
    };
    mockFundRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'fund-1', workspace_id: workspaceId }),
    };
    mockPositionRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'pos-1', workspace_id: workspaceId }),
    };
    mockSourceRecordRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'src-1', workspace_id: workspaceId }),
    };

    service = new FlValuationService(
      mockDb,
      mockValuationRepo,
      mockAssetRepo,
      mockFundRepo,
      mockPositionRepo,
      mockSourceRecordRepo,
    );
  });

  describe('record valuation', () => {
    it('records an asset valuation successfully', async () => {
      const res = await service.record(workspaceId, {
        asset_id: 'asset-1',
        as_of_date: '2026-08-23',
        valuation_method: 'fundraise_round',
        currency: 'USD',
        market_value: '50000000',
        price_per_unit: '12.50',
      });

      expect(res.asset_id).toBe('asset-1');
      expect(res.market_value).toBe('50000000.00000000');
      expect(res.price_per_unit).toBe('12.50000000');
      expect(mockDb.transaction).toHaveBeenCalled();
    });

    it('rejects non-string numeric inputs at runtime', async () => {
      await expect(
        service.record(workspaceId, {
          asset_id: 'asset-1',
          as_of_date: '2026-08-23',
          market_value: 50000000 as any,
        }),
      ).rejects.toThrow(InvalidEntryShapeError);
    });

    it('rejects target with 0 or multiple targets (XOR validation)', async () => {
      // 0 targets
      await expect(
        service.record(workspaceId, {
          as_of_date: '2026-08-23',
        }),
      ).rejects.toThrow(InvalidValuationTargetError);

      // 2 targets
      await expect(
        service.record(workspaceId, {
          asset_id: 'asset-1',
          fund_id: 'fund-1',
          as_of_date: '2026-08-23',
        }),
      ).rejects.toThrow(InvalidValuationTargetError);
    });

    it('rejects invalid currency', async () => {
      await expect(
        service.record(workspaceId, {
          asset_id: 'asset-1',
          as_of_date: '2026-08-23',
          currency: 'INVALID_CURRENCY',
        }),
      ).rejects.toThrow(InvalidCurrencyError);
    });

    it('rejects target not belonging to workspace', async () => {
      mockAssetRepo.findById.mockResolvedValue(undefined);

      await expect(
        service.record(workspaceId, {
          asset_id: 'asset-other-ws',
          as_of_date: '2026-08-23',
        }),
      ).rejects.toThrow(WorkspaceMismatchError);
    });

    it('threads sentinel executor to all repo lookups and writes without nested tx', async () => {
      await service.record(
        workspaceId,
        {
          id: 'val-fixed-1',
          position_id: 'pos-1',
          as_of_date: '2026-08-23',
          source_record_id: 'src-1',
          market_value: '100000',
        },
        sentinelExecutor,
      );

      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockPositionRepo.findById).toHaveBeenCalledWith(workspaceId, 'pos-1', sentinelExecutor);
      expect(mockSourceRecordRepo.findById).toHaveBeenCalledWith(workspaceId, 'src-1', sentinelExecutor);
      expect(mockValuationRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'val-fixed-1', position_id: 'pos-1' }),
        sentinelExecutor,
      );
    });
  });

  describe('series and latest lookups', () => {
    it('retrieves series for target', async () => {
      mockValuationRepo.findSeriesByTarget.mockResolvedValue([{ id: 'v1' }, { id: 'v2' }]);
      const series = await service.getSeries(workspaceId, { assetId: 'asset-1' });
      expect(series).toHaveLength(2);
      expect(mockValuationRepo.findSeriesByTarget).toHaveBeenCalledWith(
        workspaceId,
        { assetId: 'asset-1' },
        undefined,
      );
    });

    it('retrieves latest valuations for batched targets', async () => {
      mockValuationRepo.findLatestByAssetIds.mockResolvedValue([{ id: 'v-a1' }]);
      mockValuationRepo.findLatestByFundIds.mockResolvedValue([{ id: 'v-f1' }]);
      mockValuationRepo.findLatestByPositionIds.mockResolvedValue([{ id: 'v-p1' }]);

      const latest = await service.getLatestForTargets(
        workspaceId,
        { assetIds: ['asset-1'], fundIds: ['fund-1'], positionIds: ['pos-1'] },
        '2026-08-23',
        sentinelExecutor,
      );

      expect(latest.assets).toHaveLength(1);
      expect(latest.funds).toHaveLength(1);
      expect(latest.positions).toHaveLength(1);
      expect(mockValuationRepo.findLatestByAssetIds).toHaveBeenCalledWith(
        workspaceId,
        ['asset-1'],
        '2026-08-23',
        sentinelExecutor,
      );
    });
  });

  describe('update and delete valuation', () => {
    it('updates valuation and validates strict string money', async () => {
      mockValuationRepo.findById.mockResolvedValue({
        id: 'val-1',
        asset_id: 'asset-1',
        workspace_id: workspaceId,
      });

      const updated = await service.update(workspaceId, 'val-1', {
        market_value: '60000000',
        price_per_unit: '15.00',
      });

      expect(updated.market_value).toBe('60000000.00000000');
      expect(updated.price_per_unit).toBe('15.00000000');
      expect(mockValuationRepo.update).toHaveBeenCalledWith(
        'val-1',
        expect.objectContaining({
          market_value: '60000000.00000000',
          price_per_unit: '15.00000000',
        }),
        mockDb,
      );
    });

    it('rejects numeric money on update at runtime', async () => {
      await expect(
        service.update(workspaceId, 'val-1', {
          market_value: 60000000 as any,
        }),
      ).rejects.toThrow(InvalidEntryShapeError);
    });

    it('deletes valuation by id after workspace check', async () => {
      mockValuationRepo.findById.mockResolvedValue({
        id: 'val-1',
        asset_id: 'asset-1',
        workspace_id: workspaceId,
      });

      await service.delete(workspaceId, 'val-1');
      expect(mockValuationRepo.delete).toHaveBeenCalledWith('val-1', mockDb);
    });

    it('rejects recording position valuation with as_of_date before position opened_at', async () => {
      mockPositionRepo.findById.mockResolvedValue({
        id: 'pos-1',
        workspace_id: workspaceId,
        opened_at: '2026-06-01',
      });

      await expect(
        service.record(workspaceId, {
          position_id: 'pos-1',
          as_of_date: '2026-05-31',
          market_value: '1000000',
        }),
      ).rejects.toThrow(InvalidEntryShapeError);
    });

    it('rejects updating position valuation with as_of_date before position opened_at', async () => {
      mockValuationRepo.findById.mockResolvedValue({
        id: 'val-pos-1',
        position_id: 'pos-1',
        workspace_id: workspaceId,
        as_of_date: '2026-06-15',
      });
      mockPositionRepo.findById.mockResolvedValue({
        id: 'pos-1',
        workspace_id: workspaceId,
        opened_at: '2026-06-01',
      });

      await expect(
        service.update(workspaceId, 'val-pos-1', {
          as_of_date: '2026-05-31',
        }),
      ).rejects.toThrow(InvalidEntryShapeError);
    });

    it('threads sentinel executor for update and delete', async () => {
      mockValuationRepo.findById.mockResolvedValue({
        id: 'val-1',
        asset_id: 'asset-1',
        workspace_id: workspaceId,
      });

      await service.update(
        workspaceId,
        'val-1',
        { market_value: '70000000' },
        sentinelExecutor,
      );
      expect(mockValuationRepo.update).toHaveBeenCalledWith(
        'val-1',
        expect.anything(),
        sentinelExecutor,
      );

      await service.delete(workspaceId, 'val-1', sentinelExecutor);
      expect(mockValuationRepo.delete).toHaveBeenCalledWith('val-1', sentinelExecutor);
    });
  });
});
