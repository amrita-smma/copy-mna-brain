import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlPositionRepository } from './flPositionRepository';
import type { DbClient } from './types';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function createMockDb(): MockDb {
  const mock: MockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  };
  return mock;
}

describe('FlPositionRepository', () => {
  let mockDb: MockDb;
  let repo: FlPositionRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new FlPositionRepository(mockDb as never);
  });

  describe('create and insert', () => {
    it('creates a position record and returns it', async () => {
      const position = {
        id: 'pos-1',
        workspace_id: 'ws-1',
        holder_investor_id: 'inv-1',
        fund_id: 'fund-1',
        status: 'open',
      };
      mockDb.returning.mockResolvedValueOnce([position]);

      const result = await repo.create({
        workspace_id: 'ws-1',
        holder_investor_id: 'inv-1',
        fund_id: 'fund-1',
        status: 'open',
      } as never);

      expect(result).toEqual(position);
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });

    it('insert delegates to create and respects supplied executor', async () => {
      const executorMock = createMockDb();
      const position = { id: 'pos-2', workspace_id: 'ws-1', status: 'open' };
      executorMock.returning.mockResolvedValueOnce([position]);

      const result = await repo.insert(
        { workspace_id: 'ws-1', status: 'open' } as never,
        executorMock as unknown as DbClient,
      );

      expect(result).toEqual(position);
      expect(executorMock.insert).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('returns position by workspaceId and id when found', async () => {
      const position = { id: 'pos-1', workspace_id: 'ws-1', status: 'open' };
      mockDb.limit.mockResolvedValueOnce([position]);

      const result = await repo.findById('ws-1', 'pos-1');
      expect(result).toEqual(position);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      const position = { id: 'pos-1', workspace_id: 'ws-1', status: 'open' };
      executorMock.limit.mockResolvedValueOnce([position]);

      const result = await repo.findById('ws-1', 'pos-1', executorMock as unknown as DbClient);
      expect(result).toEqual(position);
      expect(executorMock.select).toHaveBeenCalledTimes(1);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe('findByIds', () => {
    it('returns empty array without hitting db when ids is empty', async () => {
      const result = await repo.findByIds('ws-1', []);
      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('returns positions matching ids scoped to workspace', async () => {
      const positions = [{ id: 'pos-1' }, { id: 'pos-2' }];
      mockDb.orderBy.mockResolvedValueOnce(positions);

      const result = await repo.findByIds('ws-1', ['pos-1', 'pos-2']);
      expect(result).toEqual(positions);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('findByWorkspaceId', () => {
    it('returns all positions in workspace', async () => {
      const positions = [{ id: 'pos-1' }, { id: 'pos-2' }];
      mockDb.orderBy.mockResolvedValueOnce(positions);

      const result = await repo.findByWorkspaceId('ws-1');
      expect(result).toEqual(positions);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('findByFundIds', () => {
    it('returns empty array without hitting db when fundIds is empty', async () => {
      const result = await repo.findByFundIds('ws-1', []);
      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('returns positions for specified funds scoped to workspace', async () => {
      const positions = [{ id: 'pos-1', fund_id: 'f-1' }];
      mockDb.orderBy.mockResolvedValueOnce(positions);

      const result = await repo.findByFundIds('ws-1', ['f-1']);
      expect(result).toEqual(positions);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('findByHolderInvestorIds', () => {
    it('returns empty array without hitting db when holderInvestorIds is empty', async () => {
      const result = await repo.findByHolderInvestorIds('ws-1', []);
      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('returns positions for specified holder investor ids scoped to workspace', async () => {
      const positions = [{ id: 'pos-1', holder_investor_id: 'inv-1' }];
      mockDb.orderBy.mockResolvedValueOnce(positions);

      const result = await repo.findByHolderInvestorIds('ws-1', ['inv-1']);
      expect(result).toEqual(positions);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('findByHolderFundIds', () => {
    it('returns empty array without hitting db when holderFundIds is empty', async () => {
      const result = await repo.findByHolderFundIds('ws-1', []);
      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('returns positions for specified holder fund ids scoped to workspace', async () => {
      const positions = [{ id: 'pos-1', holder_fund_id: 'hf-1' }];
      mockDb.orderBy.mockResolvedValueOnce(positions);

      const result = await repo.findByHolderFundIds('ws-1', ['hf-1']);
      expect(result).toEqual(positions);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('findByAssetIds', () => {
    it('returns empty array without hitting db when assetIds is empty', async () => {
      const result = await repo.findByAssetIds('ws-1', []);
      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('returns positions for specified asset ids scoped to workspace', async () => {
      const positions = [{ id: 'pos-1', asset_id: 'a-1' }];
      mockDb.orderBy.mockResolvedValueOnce(positions);

      const result = await repo.findByAssetIds('ws-1', ['a-1']);
      expect(result).toEqual(positions);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('findByHolderSourceOfFundIds', () => {
    it('returns empty array without hitting db when holderSourceOfFundIds is empty', async () => {
      const result = await repo.findByHolderSourceOfFundIds('ws-1', []);
      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('returns positions for specified funding source ids scoped to workspace', async () => {
      const positions = [{ id: 'pos-1', holder_source_of_fund_id: 'fs-1' }];
      mockDb.orderBy.mockResolvedValueOnce(positions);

      const result = await repo.findByHolderSourceOfFundIds('ws-1', ['fs-1']);
      expect(result).toEqual(positions);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      const positions = [{ id: 'pos-1', holder_source_of_fund_id: 'fs-1' }];
      executorMock.orderBy.mockResolvedValueOnce(positions);

      const result = await repo.findByHolderSourceOfFundIds(
        'ws-1',
        ['fs-1'],
        executorMock as unknown as DbClient,
      );
      expect(result).toEqual(positions);
      expect(executorMock.select).toHaveBeenCalledTimes(1);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe('findWithFilters', () => {
    it('filters with omitted/undefined parameters matching all positions in workspace', async () => {
      const positions = [{ id: 'pos-1' }, { id: 'pos-2' }];
      mockDb.orderBy.mockResolvedValueOnce(positions);

      const result = await repo.findWithFilters('ws-1', {});
      expect(result).toEqual(positions);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });

    it('handles tri-state holderSourceOfFundId filter (null = IS NULL, string = equality)', async () => {
      const positions = [{ id: 'pos-1', holder_source_of_fund_id: null }];
      mockDb.orderBy.mockResolvedValueOnce(positions);

      const result = await repo.findWithFilters('ws-1', {
        holderSourceOfFundId: null,
      });
      expect(result).toEqual(positions);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      const positions = [{ id: 'pos-1' }];
      executorMock.orderBy.mockResolvedValueOnce(positions);

      const result = await repo.findWithFilters(
        'ws-1',
        { fundId: 'fund-1' },
        executorMock as unknown as DbClient,
      );
      expect(result).toEqual(positions);
      expect(executorMock.select).toHaveBeenCalledTimes(1);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe('findByNaturalKey', () => {
    it('finds position with object input scoped to workspace including holderSourceOfFundId', async () => {
      const position = {
        id: 'pos-1',
        workspace_id: 'ws-1',
        holder_investor_id: 'inv-1',
        fund_id: 'f-1',
        holder_source_of_fund_id: 'fs-1',
      };
      mockDb.limit.mockResolvedValueOnce([position]);

      const result = await repo.findByNaturalKey('ws-1', {
        holderInvestorId: 'inv-1',
        fundId: 'f-1',
        holderSourceOfFundId: 'fs-1',
      });
      expect(result).toEqual(position);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });

    it('finds position with positional input scoped to workspace including holderSourceOfFundId', async () => {
      const position = {
        id: 'pos-2',
        workspace_id: 'ws-1',
        holder_fund_id: 'f-1',
        asset_id: 'a-1',
        holder_source_of_fund_id: 'fs-2',
      };
      mockDb.limit.mockResolvedValueOnce([position]);

      const result = await repo.findByNaturalKey('ws-1', null, 'f-1', null, 'a-1', 'fs-2');
      expect(result).toEqual(position);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });

    it('uses supplied executor when provided with object key', async () => {
      const executorMock = createMockDb();
      const position = { id: 'pos-1', workspace_id: 'ws-1' };
      executorMock.limit.mockResolvedValueOnce([position]);

      const result = await repo.findByNaturalKey(
        'ws-1',
        { holderInvestorId: 'inv-1', fundId: 'f-1' },
        executorMock as unknown as DbClient,
      );
      expect(result).toEqual(position);
      expect(executorMock.select).toHaveBeenCalledTimes(1);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe('updateStatus', () => {
    it('updates position status and closed_at date scoped to workspace', async () => {
      const updated = { id: 'pos-1', workspace_id: 'ws-1', status: 'closed', closed_at: '2026-06-30' };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const result = await repo.updateStatus('ws-1', 'pos-1', 'closed', '2026-06-30');
      expect(result).toEqual(updated);
      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateStatuses', () => {
    it('returns empty array without querying database when ids is empty', async () => {
      const result = await repo.updateStatuses('ws-1', [], 'closed', '2026-06-30');
      expect(result).toEqual([]);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('updates multiple positions and returns them in stable input order', async () => {
      const updated1 = { id: 'pos-1', workspace_id: 'ws-1', status: 'closed', closed_at: '2026-06-30' };
      const updated2 = { id: 'pos-2', workspace_id: 'ws-1', status: 'closed', closed_at: '2026-06-30' };
      // Database might return in any order, e.g. [updated2, updated1]
      mockDb.returning.mockResolvedValueOnce([updated2, updated1]);

      const result = await repo.updateStatuses('ws-1', ['pos-1', 'pos-2'], 'closed', '2026-06-30');
      // Returned in input order: ['pos-1', 'pos-2']
      expect(result).toEqual([updated1, updated2]);
      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      const updated = { id: 'pos-1', workspace_id: 'ws-1', status: 'closed', closed_at: '2026-06-30' };
      executorMock.returning.mockResolvedValueOnce([updated]);

      const result = await repo.updateStatuses(
        'ws-1',
        ['pos-1'],
        'closed',
        '2026-06-30',
        executorMock as unknown as DbClient,
      );

      expect(result).toEqual([updated]);
      expect(executorMock.update).toHaveBeenCalledTimes(1);
      expect(mockDb.update).not.toHaveBeenCalled();
    });
  });

  describe('update and delete', () => {
    it('updates position updates scoped by workspace', async () => {
      const updated = { id: 'pos-1', workspace_id: 'ws-1', notes: 'Updated note' };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const result = await repo.update('ws-1', 'pos-1', { notes: 'Updated note' } as never);
      expect(result).toEqual(updated);
      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });

    it('deletes position by workspace and id', async () => {
      mockDb.where.mockResolvedValueOnce(undefined);
      await repo.delete('ws-1', 'pos-1');
      expect(mockDb.delete).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('findCashPosition', () => {
    it('findCashPosition queries position with holder_fund_id and cash asset_id', async () => {
      const cashPos = {
        id: 'pos-cash-1',
        workspace_id: 'ws-1',
        holder_fund_id: 'fund-1',
        holder_investor_id: null,
        fund_id: null,
        asset_id: 'asset-cash-usd',
        holder_source_of_fund_id: null,
        status: 'open',
      };
      mockDb.limit.mockResolvedValueOnce([cashPos]);

      const result = await repo.findCashPosition('ws-1', 'fund-1', 'asset-cash-usd');
      expect(result).toEqual(cashPos);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });

    it('findCashPosition supports holder discriminator object for fund', async () => {
      const cashPos = {
        id: 'pos-cash-1',
        workspace_id: 'ws-1',
        holder_fund_id: 'fund-1',
        holder_investor_id: null,
        fund_id: null,
        asset_id: 'asset-cash-usd',
        holder_source_of_fund_id: null,
        status: 'open',
      };
      mockDb.limit.mockResolvedValueOnce([cashPos]);

      const result = await repo.findCashPosition(
        'ws-1',
        { kind: 'fund', id: 'fund-1' },
        'asset-cash-usd',
      );
      expect(result).toEqual(cashPos);
    });
  });
});
