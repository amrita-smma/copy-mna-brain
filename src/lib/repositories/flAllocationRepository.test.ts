import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlAllocationRepository } from './flAllocationRepository';
import type { DbClient } from './types';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  innerJoin: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function createMockDb(): MockDb {
  const mock: MockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn(),
    limit: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    delete: vi.fn().mockReturnThis(),
  };
  return mock;
}

describe('FlAllocationRepository', () => {
  let mockDb: MockDb;
  let repo: FlAllocationRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new FlAllocationRepository(mockDb as never);
  });

  describe('create and createMany', () => {
    it('creates single allocation', async () => {
      const alloc = { id: 'alloc-1', ledger_entry_id: 'le-1', funding_source_id: 'fs-1', amount: '50000.00000000' };
      mockDb.returning.mockResolvedValueOnce([alloc]);

      const result = await repo.create(alloc as never);
      expect(result).toEqual(alloc);
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });

    it('createMany returns empty array without hitting db when allocations is empty', async () => {
      const result = await repo.createMany([]);
      expect(result).toEqual([]);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('createMany inserts multiple allocations and uses supplied executor', async () => {
      const executorMock = createMockDb();
      const allocs = [
        { id: 'a1', ledger_entry_id: 'le-1', funding_source_id: 'fs-1', amount: '30000.00000000' },
        { id: 'a2', ledger_entry_id: 'le-1', funding_source_id: 'fs-2', amount: '20000.00000000' },
      ];
      executorMock.returning.mockResolvedValueOnce(allocs);

      const result = await repo.createMany(allocs as never, executorMock as unknown as DbClient);
      expect(result).toEqual(allocs);
      expect(executorMock.insert).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('returns allocation by id and workspace when found via join', async () => {
      const alloc = { id: 'alloc-1', amount: '100.00000000' };
      mockDb.limit.mockResolvedValueOnce([{ allocation: alloc }]);

      const result = await repo.findById('ws-1', 'alloc-1');
      expect(result).toEqual(alloc);
      expect(mockDb.innerJoin).toHaveBeenCalledTimes(2);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      const alloc = { id: 'alloc-1', amount: '100.00000000' };
      executorMock.limit.mockResolvedValueOnce([{ allocation: alloc }]);

      const result = await repo.findById('ws-1', 'alloc-1', executorMock as unknown as DbClient);
      expect(result).toEqual(alloc);
      expect(executorMock.select).toHaveBeenCalledTimes(1);
      expect(executorMock.innerJoin).toHaveBeenCalledTimes(2);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe('findByLedgerEntryIds', () => {
    it('returns empty array without hitting db when ledgerEntryIds is empty', async () => {
      const result = await repo.findByLedgerEntryIds('ws-1', []);
      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('returns allocations for specified ledger entry ids scoped to workspace via parent join', async () => {
      const allocs = [
        { id: 'a1', ledger_entry_id: 'le-1' },
        { id: 'a2', ledger_entry_id: 'le-1' },
      ];
      mockDb.orderBy.mockResolvedValueOnce(allocs.map((a) => ({ allocation: a })));

      const result = await repo.findByLedgerEntryIds('ws-1', ['le-1']);
      expect(result).toEqual(allocs);
      expect(mockDb.innerJoin).toHaveBeenCalledTimes(2);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('findByFundingSourceIds', () => {
    it('returns empty array without hitting db when fundingSourceIds is empty', async () => {
      const result = await repo.findByFundingSourceIds('ws-1', []);
      expect(result).toEqual([]);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('returns allocations for specified funding source ids scoped to workspace', async () => {
      const allocs = [{ id: 'a1', funding_source_id: 'fs-1' }];
      mockDb.orderBy.mockResolvedValueOnce(allocs.map((a) => ({ allocation: a })));

      const result = await repo.findByFundingSourceIds('ws-1', ['fs-1']);
      expect(result).toEqual(allocs);
      expect(mockDb.innerJoin).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('findByWorkspaceId', () => {
    it('returns all allocations in workspace joining ledger entries and positions', async () => {
      const allocs = [{ id: 'a1' }, { id: 'a2' }];
      mockDb.orderBy.mockResolvedValueOnce(allocs.map((a) => ({ allocation: a })));

      const result = await repo.findByWorkspaceId('ws-1');
      expect(result).toEqual(allocs);
      expect(mockDb.innerJoin).toHaveBeenCalledTimes(2);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      const allocs = [{ id: 'a1' }];
      executorMock.orderBy.mockResolvedValueOnce(allocs.map((a) => ({ allocation: a })));

      const result = await repo.findByWorkspaceId('ws-1', executorMock as unknown as DbClient);
      expect(result).toEqual(allocs);
      expect(executorMock.select).toHaveBeenCalledTimes(1);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe('delete and deleteByLedgerEntryId', () => {
    it('deletes allocation by id', async () => {
      mockDb.where.mockResolvedValueOnce(undefined);
      await repo.delete('a1');
      expect(mockDb.delete).toHaveBeenCalledTimes(1);
    });

    it('deletes allocations by ledger_entry_id', async () => {
      mockDb.where.mockResolvedValueOnce(undefined);
      await repo.deleteByLedgerEntryId('le-1');
      expect(mockDb.delete).toHaveBeenCalledTimes(1);
    });

    it('returns without hitting the DB when deleteByLedgerEntryIds is empty', async () => {
      await repo.deleteByLedgerEntryIds([]);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it('deletes allocations for many ledger entry ids', async () => {
      mockDb.where.mockResolvedValueOnce(undefined);
      await repo.deleteByLedgerEntryIds(['le-1', 'le-2']);
      expect(mockDb.delete).toHaveBeenCalledTimes(1);
    });
  });
});
