import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '@/lib/repositories';
import {
  DuplicatePositionError,
  IneligibleCashHolderError,
  InvalidPositionShapeError,
  PositionNotSettledError,
  WorkspaceMismatchError,
} from './flErrors';
import { FlPositionService } from './flPositionService';

describe('FlPositionService', () => {
  let mockDb: any;
  let mockPositionRepo: any;
  let mockInvestorRepo: any;
  let mockFundRepo: any;
  let mockAssetRepo: any;
  let mockLedgerRepo: any;
  let mockFundingSourceRepo: any;
  let service: FlPositionService;

  const workspaceId = 'ws-test-1';
  const sentinelExecutor = { __sentinel: 'tx-exec' } as unknown as DbClient;

  beforeEach(() => {
    mockDb = {
      transaction: vi.fn(async (cb: any) => cb(mockDb)),
    };
    mockPositionRepo = {
      findByWorkspaceId: vi.fn().mockResolvedValue([]),
      findById: vi.fn().mockResolvedValue(undefined),
      findByIds: vi.fn().mockResolvedValue([]),
      findByNaturalKey: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockImplementation((data: any) => Promise.resolve({ ...data, id: data.id ?? 'pos-1' })),
      update: vi.fn().mockImplementation((_ws: string, id: string, updates: Record<string, unknown>) =>
        Promise.resolve({ id, ...updates }),
      ),
      updateStatus: vi.fn().mockImplementation((_ws: string, id: string, status: string, closedAt: string | null) =>
        Promise.resolve({ id, status, closed_at: closedAt }),
      ),
      updateStatuses: vi.fn().mockImplementation((_ws: string, ids: string[], status: string, closedAt: string | null) =>
        Promise.resolve(ids.map((id) => ({ id, status, closed_at: closedAt }))),
      ),
      findByFundIds: vi.fn().mockResolvedValue([]),
      findByHolderInvestorIds: vi.fn().mockResolvedValue([]),
      findByHolderFundIds: vi.fn().mockResolvedValue([]),
      findByAssetIds: vi.fn().mockResolvedValue([]),
      findWithFilters: vi.fn().mockResolvedValue([]),
      findCashPosition: vi.fn().mockResolvedValue(undefined),
    };
    mockInvestorRepo = {
      findById: vi.fn().mockResolvedValue(undefined),
    };
    mockFundRepo = {
      findById: vi.fn().mockResolvedValue(undefined),
    };
    mockAssetRepo = {
      findById: vi.fn().mockResolvedValue(undefined),
      findSystemCashAsset: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockImplementation((data: any) => Promise.resolve({ ...data, id: data.id ?? 'asset-cash-usd' })),
    };
    mockLedgerRepo = {
      sumDeltasByPositionIds: vi.fn().mockResolvedValue([]),
    };
    mockFundingSourceRepo = {
      findById: vi.fn().mockResolvedValue(undefined),
    };

    service = new FlPositionService(
      mockDb,
      mockPositionRepo,
      mockInvestorRepo,
      mockFundRepo,
      mockAssetRepo,
      mockLedgerRepo,
      mockFundingSourceRepo,
    );
  });

  describe('openPosition & getOrOpenPosition', () => {
    it('opens an investor-fund position (LP commitment) successfully', async () => {
      mockInvestorRepo.findById.mockResolvedValue({ id: 'inv-1', workspace_id: workspaceId });
      mockFundRepo.findById.mockResolvedValue({ id: 'fund-1', workspace_id: workspaceId });

      const pos = await service.openPosition(workspaceId, {
        holder_investor_id: 'inv-1',
        fund_id: 'fund-1',
      });

      expect(pos.id).toBe('pos-1');
      expect(pos.status).toBe('open');
      expect(mockPositionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_id: workspaceId,
          holder_investor_id: 'inv-1',
          fund_id: 'fund-1',
        }),
        mockDb,
      );
    });

    it('opens a fund-asset position (direct company investment) successfully', async () => {
      mockFundRepo.findById.mockResolvedValue({ id: 'fund-1', workspace_id: workspaceId });
      mockAssetRepo.findById.mockResolvedValue({ id: 'asset-1', workspace_id: workspaceId });

      const pos = await service.openPosition(workspaceId, {
        holder_fund_id: 'fund-1',
        asset_id: 'asset-1',
      });

      expect(pos.id).toBe('pos-1');
      expect(pos.status).toBe('open');
      expect(mockPositionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_id: workspaceId,
          holder_fund_id: 'fund-1',
          asset_id: 'asset-1',
        }),
        mockDb,
      );
    });

    it('opens a fund-fund position (fund-of-funds) successfully', async () => {
      mockFundRepo.findById.mockImplementation((_ws: string, id: string) => {
        if (id === 'fund-1') return Promise.resolve({ id: 'fund-1', workspace_id: workspaceId });
        if (id === 'target-fund-2') return Promise.resolve({ id: 'target-fund-2', workspace_id: workspaceId });
        return Promise.resolve(undefined);
      });

      const pos = await service.openPosition(workspaceId, {
        holder_fund_id: 'fund-1',
        fund_id: 'target-fund-2',
      });

      expect(pos.id).toBe('pos-1');
      expect(pos.status).toBe('open');
      expect(mockPositionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_id: workspaceId,
          holder_fund_id: 'fund-1',
          fund_id: 'target-fund-2',
        }),
        mockDb,
      );
    });

    it('opens an investor-asset position (direct company investment held by investor) successfully', async () => {
      mockInvestorRepo.findById.mockResolvedValue({ id: 'inv-1', workspace_id: workspaceId });
      mockAssetRepo.findById.mockResolvedValue({ id: 'asset-1', workspace_id: workspaceId });

      const pos = await service.openPosition(workspaceId, {
        holder_investor_id: 'inv-1',
        asset_id: 'asset-1',
      });

      expect(pos.id).toBe('pos-1');
      expect(pos.status).toBe('open');
      expect(mockPositionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_id: workspaceId,
          holder_investor_id: 'inv-1',
          asset_id: 'asset-1',
        }),
        mockDb,
      );
    });

    it('rejects shape with 0 holders or 2 holders', async () => {
      await expect(
        service.openPosition(workspaceId, {
          fund_id: 'fund-1',
        }),
      ).rejects.toThrow(InvalidPositionShapeError);

      await expect(
        service.openPosition(workspaceId, {
          holder_investor_id: 'inv-1',
          holder_fund_id: 'fund-holder-1',
          fund_id: 'fund-1',
        }),
      ).rejects.toThrow(InvalidPositionShapeError);
    });

    it('rejects shape with 0 instruments or 2 instruments', async () => {
      await expect(
        service.openPosition(workspaceId, {
          holder_investor_id: 'inv-1',
        }),
      ).rejects.toThrow(InvalidPositionShapeError);

      await expect(
        service.openPosition(workspaceId, {
          holder_investor_id: 'inv-1',
          fund_id: 'fund-1',
          asset_id: 'asset-1',
        }),
      ).rejects.toThrow(InvalidPositionShapeError);
    });

    it('rejects a fund holding itself', async () => {
      await expect(
        service.openPosition(workspaceId, {
          holder_fund_id: 'fund-1',
          fund_id: 'fund-1',
        }),
      ).rejects.toThrow(InvalidPositionShapeError);
    });

    it('validates all referenced rows belong to workspaceId', async () => {
      mockInvestorRepo.findById.mockResolvedValue(undefined); // not in workspace

      await expect(
        service.openPosition(workspaceId, {
          holder_investor_id: 'inv-other-ws',
          fund_id: 'fund-1',
        }),
      ).rejects.toThrow(WorkspaceMismatchError);
    });

    it('rejects duplicate position on openPosition', async () => {
      mockInvestorRepo.findById.mockResolvedValue({ id: 'inv-1', workspace_id: workspaceId });
      mockFundRepo.findById.mockResolvedValue({ id: 'fund-1', workspace_id: workspaceId });
      mockPositionRepo.findByNaturalKey.mockResolvedValue({ id: 'pos-existing' });

      await expect(
        service.openPosition(workspaceId, {
          holder_investor_id: 'inv-1',
          fund_id: 'fund-1',
        }),
      ).rejects.toThrow(DuplicatePositionError);
    });

    it('getOrOpenPosition returns existing without throwing', async () => {
      mockInvestorRepo.findById.mockResolvedValue({ id: 'inv-1', workspace_id: workspaceId });
      mockFundRepo.findById.mockResolvedValue({ id: 'fund-1', workspace_id: workspaceId });
      mockPositionRepo.findByNaturalKey.mockResolvedValue({ id: 'pos-existing', status: 'open', opened_at: '2026-01-15' });

      const pos = await service.getOrOpenPosition(workspaceId, {
        holder_investor_id: 'inv-1',
        fund_id: 'fund-1',
      });

      expect(pos.id).toBe('pos-existing');
      expect(mockPositionRepo.create).not.toHaveBeenCalled();
      expect(mockPositionRepo.update).not.toHaveBeenCalled();
    });

    it('getOrOpenPosition backdates opened_at when new evidence is earlier', async () => {
      mockInvestorRepo.findById.mockResolvedValue({ id: 'inv-1', workspace_id: workspaceId });
      mockFundRepo.findById.mockResolvedValue({ id: 'fund-1', workspace_id: workspaceId });
      mockPositionRepo.findByNaturalKey.mockResolvedValue({
        id: 'pos-existing',
        status: 'open',
        opened_at: '2026-01-15',
      });
      mockPositionRepo.update.mockResolvedValue({
        id: 'pos-existing',
        status: 'open',
        opened_at: '2025-12-31',
      });

      const pos = await service.getOrOpenPosition(workspaceId, {
        holder_investor_id: 'inv-1',
        fund_id: 'fund-1',
        opened_at: '2025-12-31',
      });

      expect(mockPositionRepo.update).toHaveBeenCalledWith(
        workspaceId,
        'pos-existing',
        { opened_at: '2025-12-31' },
        mockDb,
      );
      expect(pos.opened_at).toBe('2025-12-31');
      expect(mockPositionRepo.create).not.toHaveBeenCalled();
    });

    it('threads sentinel executor across all lookups and inserts', async () => {
      mockFundRepo.findById.mockResolvedValue({ id: 'fund-1', workspace_id: workspaceId });
      mockAssetRepo.findById.mockResolvedValue({ id: 'asset-1', workspace_id: workspaceId });

      await service.openPosition(
        workspaceId,
        {
          holder_fund_id: 'fund-1',
          asset_id: 'asset-1',
        },
        sentinelExecutor,
      );

      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockFundRepo.findById).toHaveBeenCalledWith(workspaceId, 'fund-1', sentinelExecutor);
      expect(mockAssetRepo.findById).toHaveBeenCalledWith(workspaceId, 'asset-1', sentinelExecutor);
      expect(mockPositionRepo.findByNaturalKey).toHaveBeenCalledWith(workspaceId, expect.anything(), sentinelExecutor);
      expect(mockPositionRepo.create).toHaveBeenCalledWith(expect.anything(), sentinelExecutor);
    });

    it('opens position with holder_source_of_fund_id and validates workspace', async () => {
      mockFundingSourceRepo.findById.mockResolvedValue({ id: 'fs-1', workspace_id: workspaceId });
      mockInvestorRepo.findById.mockResolvedValue({ id: 'inv-1', workspace_id: workspaceId });
      mockFundRepo.findById.mockResolvedValue({ id: 'fund-1', workspace_id: workspaceId });

      const pos = await service.openPosition(
        workspaceId,
        {
          holder_investor_id: 'inv-1',
          fund_id: 'fund-1',
          holder_source_of_fund_id: 'fs-1',
        },
        sentinelExecutor,
      );

      expect(pos.id).toBe('pos-1');
      expect(mockFundingSourceRepo.findById).toHaveBeenCalledWith(workspaceId, 'fs-1', sentinelExecutor);
      expect(mockPositionRepo.findByNaturalKey).toHaveBeenCalledWith(
        workspaceId,
        expect.objectContaining({ holderSourceOfFundId: 'fs-1' }),
        sentinelExecutor,
      );
      expect(mockPositionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ holder_source_of_fund_id: 'fs-1' }),
        sentinelExecutor,
      );
    });

    it('rejects position when holder_source_of_fund_id does not belong to workspace', async () => {
      mockFundingSourceRepo.findById.mockResolvedValue(undefined);
      mockInvestorRepo.findById.mockResolvedValue({ id: 'inv-1', workspace_id: workspaceId });
      mockFundRepo.findById.mockResolvedValue({ id: 'fund-1', workspace_id: workspaceId });

      await expect(
        service.openPosition(workspaceId, {
          holder_investor_id: 'inv-1',
          fund_id: 'fund-1',
          holder_source_of_fund_id: 'fs-wrong-ws',
        }),
      ).rejects.toThrow(WorkspaceMismatchError);
    });
  });

  describe('listPositions', () => {
    it('delegates to findWithFilters when holderSourceOfFundId filter is provided', async () => {
      mockPositionRepo.findWithFilters = vi.fn().mockResolvedValue([{ id: 'pos-1' }]);

      const result = await service.listPositions(
        workspaceId,
        { holderSourceOfFundId: 'fs-1' },
        sentinelExecutor,
      );

      expect(result).toEqual([{ id: 'pos-1' }]);
      expect(mockPositionRepo.findWithFilters).toHaveBeenCalledWith(
        workspaceId,
        { holderSourceOfFundId: 'fs-1' },
        sentinelExecutor,
      );
    });
  });

  describe('closePosition & reopenPosition', () => {
    it('refuses to close position with nonzero quantity balance', async () => {
      mockPositionRepo.findById.mockResolvedValue({
        id: 'pos-1',
        workspace_id: workspaceId,
        asset_id: 'asset-1',
      });
      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-1',
          quantity_sum: '100.00000000',
          commitment_sum: '0',
          cash_sum: '-1000',
          contributed_sum: '0',
        },
      ]);

      await expect(
        service.closePosition(workspaceId, 'pos-1'),
      ).rejects.toThrow(PositionNotSettledError);
    });

    it('refuses to close fund position with unfunded commitment', async () => {
      mockPositionRepo.findById.mockResolvedValue({
        id: 'pos-1',
        workspace_id: workspaceId,
        fund_id: 'fund-1',
      });
      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-1',
          quantity_sum: '0',
          commitment_sum: '1000.00000000',
          cash_sum: '-600.00000000',
          contributed_sum: '600.00000000',
        },
      ]);

      await expect(
        service.closePosition(workspaceId, 'pos-1'),
      ).rejects.toThrow(PositionNotSettledError);
    });

    it('closes fully settled fund position (quantity=0, unfunded=0)', async () => {
      mockPositionRepo.findById.mockResolvedValue({
        id: 'pos-1',
        workspace_id: workspaceId,
        fund_id: 'fund-1',
      });
      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-1',
          quantity_sum: '0.00000000',
          commitment_sum: '1000.00000000',
          cash_sum: '-1000.00000000',
          contributed_sum: '1000.00000000',
        },
      ]);

      const closed = await service.closePosition(workspaceId, 'pos-1', '2026-08-23');
      expect(closed.status).toBe('closed');
      expect(mockPositionRepo.updateStatus).toHaveBeenCalledWith(
        workspaceId,
        'pos-1',
        'closed',
        '2026-08-23',
        mockDb,
      );
    });

    it('reopens a position', async () => {
      mockPositionRepo.findById.mockResolvedValue({
        id: 'pos-1',
        workspace_id: workspaceId,
        status: 'closed',
      });

      const reopened = await service.reopenPosition(workspaceId, 'pos-1');
      expect(reopened.status).toBe('open');
      expect(mockPositionRepo.updateStatus).toHaveBeenCalledWith(
        workspaceId,
        'pos-1',
        'open',
        null,
        mockDb,
      );
    });
  });

  describe('closePositions', () => {
    it('returns empty array without db query when positionIds is empty', async () => {
      const result = await service.closePositions(workspaceId, []);
      expect(result).toEqual([]);
      expect(mockPositionRepo.findByIds).not.toHaveBeenCalled();
      expect(mockLedgerRepo.sumDeltasByPositionIds).not.toHaveBeenCalled();
      expect(mockPositionRepo.updateStatuses).not.toHaveBeenCalled();
    });

    it('closes multiple settled positions in a single batched operation', async () => {
      mockPositionRepo.findByIds.mockResolvedValue([
        { id: 'pos-1', workspace_id: workspaceId, asset_id: 'a-1' },
        { id: 'pos-2', workspace_id: workspaceId, fund_id: 'f-1' },
      ]);
      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-1',
          quantity_sum: '0',
          commitment_sum: '0',
          cash_sum: '0',
          contributed_sum: '0',
        },
        {
          position_id: 'pos-2',
          quantity_sum: '0',
          commitment_sum: '1000',
          cash_sum: '-1000',
          contributed_sum: '1000',
        },
      ]);
      mockPositionRepo.updateStatuses.mockResolvedValue([
        { id: 'pos-1', status: 'closed', closed_at: '2026-08-24' },
        { id: 'pos-2', status: 'closed', closed_at: '2026-08-24' },
      ]);

      const result = await service.closePositions(
        workspaceId,
        ['pos-1', 'pos-2'],
        '2026-08-24',
      );

      expect(result).toHaveLength(2);
      expect(mockPositionRepo.findByIds).toHaveBeenCalledWith(
        workspaceId,
        ['pos-1', 'pos-2'],
        mockDb,
      );
      expect(mockLedgerRepo.sumDeltasByPositionIds).toHaveBeenCalledWith(
        workspaceId,
        ['pos-1', 'pos-2'],
        undefined,
        mockDb,
      );
      expect(mockPositionRepo.updateStatuses).toHaveBeenCalledWith(
        workspaceId,
        ['pos-1', 'pos-2'],
        'closed',
        '2026-08-24',
        mockDb,
      );
    });

    it('atomically rejects batch when any position is missing from workspace and executes no writes', async () => {
      mockPositionRepo.findByIds.mockResolvedValue([
        { id: 'pos-1', workspace_id: workspaceId, asset_id: 'a-1' },
      ]); // pos-2 missing

      await expect(
        service.closePositions(workspaceId, ['pos-1', 'pos-2']),
      ).rejects.toThrow(/Position pos-2 not found/);

      expect(mockPositionRepo.updateStatuses).not.toHaveBeenCalled();
      expect(mockPositionRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('atomically rejects batch when any position has nonzero quantity and executes no writes', async () => {
      mockPositionRepo.findByIds.mockResolvedValue([
        { id: 'pos-1', workspace_id: workspaceId, asset_id: 'a-1' },
        { id: 'pos-2', workspace_id: workspaceId, asset_id: 'a-2' },
      ]);
      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-1',
          quantity_sum: '0',
          commitment_sum: '0',
          cash_sum: '0',
          contributed_sum: '0',
        },
        {
          position_id: 'pos-2',
          quantity_sum: '50.00000000',
          commitment_sum: '0',
          cash_sum: '-500',
          contributed_sum: '0',
        },
      ]);

      await expect(
        service.closePositions(workspaceId, ['pos-1', 'pos-2']),
      ).rejects.toThrow(PositionNotSettledError);

      expect(mockPositionRepo.updateStatuses).not.toHaveBeenCalled();
      expect(mockPositionRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('atomically rejects batch when any fund position has unfunded commitment and executes no writes', async () => {
      mockPositionRepo.findByIds.mockResolvedValue([
        { id: 'pos-1', workspace_id: workspaceId, asset_id: 'a-1' },
        { id: 'pos-2', workspace_id: workspaceId, fund_id: 'f-1' },
      ]);
      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-1',
          quantity_sum: '0',
          commitment_sum: '0',
          cash_sum: '0',
          contributed_sum: '0',
        },
        {
          position_id: 'pos-2',
          quantity_sum: '0',
          commitment_sum: '1000',
          cash_sum: '-600',
          contributed_sum: '600', // 400 unfunded remaining
        },
      ]);

      await expect(
        service.closePositions(workspaceId, ['pos-1', 'pos-2']),
      ).rejects.toThrow(PositionNotSettledError);

      expect(mockPositionRepo.updateStatuses).not.toHaveBeenCalled();
      expect(mockPositionRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('threads executor across all batch operations', async () => {
      mockPositionRepo.findByIds.mockResolvedValue([
        { id: 'pos-1', workspace_id: workspaceId, asset_id: 'a-1' },
      ]);
      mockLedgerRepo.sumDeltasByPositionIds.mockResolvedValue([
        {
          position_id: 'pos-1',
          quantity_sum: '0',
          commitment_sum: '0',
          cash_sum: '0',
          contributed_sum: '0',
        },
      ]);
      mockPositionRepo.updateStatuses.mockResolvedValue([
        { id: 'pos-1', status: 'closed', closed_at: '2026-08-24' },
      ]);

      await service.closePositions(
        workspaceId,
        ['pos-1'],
        '2026-08-24',
        sentinelExecutor,
      );

      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(mockPositionRepo.findByIds).toHaveBeenCalledWith(
        workspaceId,
        ['pos-1'],
        sentinelExecutor,
      );
      expect(mockLedgerRepo.sumDeltasByPositionIds).toHaveBeenCalledWith(
        workspaceId,
        ['pos-1'],
        undefined,
        sentinelExecutor,
      );
      expect(mockPositionRepo.updateStatuses).toHaveBeenCalledWith(
        workspaceId,
        ['pos-1'],
        'closed',
        '2026-08-24',
        sentinelExecutor,
      );
    });

    it('rejects duplicate position IDs in input array', async () => {
      await expect(
        service.closePositions(workspaceId, ['pos-1', 'pos-1']),
      ).rejects.toThrow(InvalidPositionShapeError);
      expect(mockPositionRepo.findByIds).not.toHaveBeenCalled();
      expect(mockPositionRepo.updateStatuses).not.toHaveBeenCalled();
    });

    it('rejects non-string or empty elements in input array', async () => {
      await expect(
        service.closePositions(workspaceId, ['pos-1', '   ']),
      ).rejects.toThrow(InvalidPositionShapeError);
      expect(mockPositionRepo.findByIds).not.toHaveBeenCalled();
      expect(mockPositionRepo.updateStatuses).not.toHaveBeenCalled();
    });
  });

  describe('getOrCreateCashPosition', () => {
    it('creates and returns a new cash position when none exists for managed fund', async () => {
      mockFundRepo.findById.mockResolvedValue({ id: 'fund-1', workspace_id: workspaceId, managed: true });
      mockAssetRepo.findSystemCashAsset.mockResolvedValue({
        id: 'asset-cash-usd',
        workspace_id: workspaceId,
        asset_kind: 'cash',
        instrument_terms: { system_cash: true, currency: 'USD' },
      });
      mockPositionRepo.findCashPosition.mockResolvedValue(undefined);
      mockPositionRepo.create.mockResolvedValue({
        id: 'pos-cash-1',
        workspace_id: workspaceId,
        holder_fund_id: 'fund-1',
        asset_id: 'asset-cash-usd',
        status: 'open',
      });

      const pos = await service.getOrCreateCashPosition(
        workspaceId,
        { kind: 'fund', id: 'fund-1' },
        'USD',
      );

      expect(pos.id).toBe('pos-cash-1');
      expect(mockPositionRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_id: workspaceId,
          holder_fund_id: 'fund-1',
          asset_id: 'asset-cash-usd',
          status: 'open',
        }),
        expect.anything(),
      );
    });

    it('returns existing open cash position without creating a new one', async () => {
      mockFundRepo.findById.mockResolvedValue({ id: 'fund-1', workspace_id: workspaceId, managed: true });
      mockAssetRepo.findSystemCashAsset.mockResolvedValue({
        id: 'asset-cash-usd',
        workspace_id: workspaceId,
        asset_kind: 'cash',
        instrument_terms: { system_cash: true, currency: 'USD' },
      });
      mockPositionRepo.findCashPosition.mockResolvedValue({
        id: 'pos-cash-existing',
        workspace_id: workspaceId,
        holder_fund_id: 'fund-1',
        asset_id: 'asset-cash-usd',
        status: 'open',
      });

      const pos = await service.getOrCreateCashPosition(
        workspaceId,
        { kind: 'fund', id: 'fund-1' },
        'USD',
      );

      expect(pos.id).toBe('pos-cash-existing');
      expect(mockPositionRepo.create).not.toHaveBeenCalled();
    });

    it('reopens closed cash position by updating status to open', async () => {
      mockFundRepo.findById.mockResolvedValue({ id: 'fund-1', workspace_id: workspaceId, managed: true });
      mockAssetRepo.findSystemCashAsset.mockResolvedValue({
        id: 'asset-cash-usd',
        workspace_id: workspaceId,
        asset_kind: 'cash',
        instrument_terms: { system_cash: true, currency: 'USD' },
      });
      mockPositionRepo.findCashPosition.mockResolvedValue({
        id: 'pos-cash-closed',
        workspace_id: workspaceId,
        holder_fund_id: 'fund-1',
        asset_id: 'asset-cash-usd',
        status: 'closed',
      });
      mockPositionRepo.update.mockResolvedValue({
        id: 'pos-cash-closed',
        workspace_id: workspaceId,
        holder_fund_id: 'fund-1',
        asset_id: 'asset-cash-usd',
        status: 'open',
      });

      const pos = await service.getOrCreateCashPosition(
        workspaceId,
        { kind: 'fund', id: 'fund-1' },
        'USD',
      );

      expect(pos.status).toBe('open');
      expect(mockPositionRepo.update).toHaveBeenCalledWith(
        workspaceId,
        'pos-cash-closed',
        { status: 'open' },
        expect.anything(),
      );
    });

    it('handles concurrent race condition gracefully when create throws duplicate key error', async () => {
      mockFundRepo.findById.mockResolvedValue({ id: 'fund-1', workspace_id: workspaceId, managed: true });
      mockAssetRepo.findSystemCashAsset.mockResolvedValue({
        id: 'asset-cash-usd',
        workspace_id: workspaceId,
        asset_kind: 'cash',
        instrument_terms: { system_cash: true, currency: 'USD' },
      });
      mockPositionRepo.findCashPosition
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          id: 'pos-cash-winner',
          workspace_id: workspaceId,
          holder_fund_id: 'fund-1',
          asset_id: 'asset-cash-usd',
          status: 'open',
        });
      mockPositionRepo.create.mockRejectedValueOnce({
        code: '23505',
        message: 'duplicate key value violates unique constraint',
      });

      const pos = await service.getOrCreateCashPosition(
        workspaceId,
        { kind: 'fund', id: 'fund-1' },
        'USD',
      );

      expect(pos.id).toBe('pos-cash-winner');
    });

    it('throws WorkspaceMismatchError if fund does not exist', async () => {
      mockFundRepo.findById.mockResolvedValue(undefined);

      await expect(
        service.getOrCreateCashPosition(
          workspaceId,
          { kind: 'fund', id: 'non-existent-fund' },
          'USD',
        ),
      ).rejects.toThrow(WorkspaceMismatchError);
    });

    it('rejects unmanaged fund with IneligibleCashHolderError when managed is false', async () => {
      mockFundRepo.findById.mockResolvedValue({
        id: 'fund-unmanaged',
        workspace_id: workspaceId,
        managed: false,
      });

      await expect(
        service.getOrCreateCashPosition(
          workspaceId,
          { kind: 'fund', id: 'fund-unmanaged' },
          'USD',
        ),
      ).rejects.toThrow(IneligibleCashHolderError);
    });

    it('rejects fund with IneligibleCashHolderError when managed is null or undefined', async () => {
      mockFundRepo.findById.mockResolvedValue({
        id: 'fund-null-managed',
        workspace_id: workspaceId,
        managed: null,
      });

      await expect(
        service.getOrCreateCashPosition(
          workspaceId,
          { kind: 'fund', id: 'fund-null-managed' },
          'USD',
        ),
      ).rejects.toThrow(IneligibleCashHolderError);
    });
  });

  describe('generic position creation/reopening cash-ownership enforcement', () => {
    it('openPosition rejects pairing cash asset with investor holder', async () => {
      mockInvestorRepo.findById.mockResolvedValue({ id: 'inv-1', workspace_id: workspaceId });
      mockAssetRepo.findById.mockResolvedValue({
        id: 'asset-cash-1',
        workspace_id: workspaceId,
        asset_kind: 'cash',
      });

      await expect(
        service.openPosition(workspaceId, {
          holder_investor_id: 'inv-1',
          asset_id: 'asset-cash-1',
        }),
      ).rejects.toThrow(IneligibleCashHolderError);
    });

    it('openPosition rejects pairing cash asset with unmanaged fund holder', async () => {
      mockFundRepo.findById.mockResolvedValue({
        id: 'fund-unmanaged-1',
        workspace_id: workspaceId,
        managed: false,
      });
      mockAssetRepo.findById.mockResolvedValue({
        id: 'asset-cash-1',
        workspace_id: workspaceId,
        asset_kind: 'cash',
      });

      await expect(
        service.openPosition(workspaceId, {
          holder_fund_id: 'fund-unmanaged-1',
          asset_id: 'asset-cash-1',
        }),
      ).rejects.toThrow(IneligibleCashHolderError);
    });

    it('openPosition allows pairing cash asset with managed fund holder', async () => {
      mockFundRepo.findById.mockResolvedValue({
        id: 'fund-managed-1',
        workspace_id: workspaceId,
        managed: true,
      });
      mockAssetRepo.findById.mockResolvedValue({
        id: 'asset-cash-1',
        workspace_id: workspaceId,
        asset_kind: 'cash',
      });
      mockPositionRepo.findByNaturalKey.mockResolvedValue(undefined);
      mockPositionRepo.create.mockResolvedValue({
        id: 'pos-created',
        workspace_id: workspaceId,
        holder_fund_id: 'fund-managed-1',
        asset_id: 'asset-cash-1',
        status: 'open',
      });

      const res = await service.openPosition(workspaceId, {
        holder_fund_id: 'fund-managed-1',
        asset_id: 'asset-cash-1',
      });
      expect(res.id).toBe('pos-created');
    });

    it('getOrOpenPosition rejects pairing cash asset with investor holder', async () => {
      mockInvestorRepo.findById.mockResolvedValue({ id: 'inv-1', workspace_id: workspaceId });
      mockAssetRepo.findById.mockResolvedValue({
        id: 'asset-cash-1',
        workspace_id: workspaceId,
        asset_kind: 'cash',
      });

      await expect(
        service.getOrOpenPosition(workspaceId, {
          holder_investor_id: 'inv-1',
          asset_id: 'asset-cash-1',
        }),
      ).rejects.toThrow(IneligibleCashHolderError);
    });

    it('reopenPosition rejects reopening cash position held by investor', async () => {
      mockPositionRepo.findById.mockResolvedValue({
        id: 'pos-inv-cash',
        workspace_id: workspaceId,
        holder_investor_id: 'inv-1',
        holder_fund_id: null,
        asset_id: 'asset-cash-1',
        status: 'closed',
      });
      mockAssetRepo.findById.mockResolvedValue({
        id: 'asset-cash-1',
        workspace_id: workspaceId,
        asset_kind: 'cash',
      });

      await expect(
        service.reopenPosition(workspaceId, 'pos-inv-cash'),
      ).rejects.toThrow(IneligibleCashHolderError);
    });

    it('reopenPosition rejects reopening cash position held by unmanaged fund', async () => {
      mockPositionRepo.findById.mockResolvedValue({
        id: 'pos-unmanaged-cash',
        workspace_id: workspaceId,
        holder_investor_id: null,
        holder_fund_id: 'fund-unmanaged',
        asset_id: 'asset-cash-1',
        status: 'closed',
      });
      mockAssetRepo.findById.mockResolvedValue({
        id: 'asset-cash-1',
        workspace_id: workspaceId,
        asset_kind: 'cash',
      });
      mockFundRepo.findById.mockResolvedValue({
        id: 'fund-unmanaged',
        workspace_id: workspaceId,
        managed: false,
      });

      await expect(
        service.reopenPosition(workspaceId, 'pos-unmanaged-cash'),
      ).rejects.toThrow(IneligibleCashHolderError);
    });
  });
});



