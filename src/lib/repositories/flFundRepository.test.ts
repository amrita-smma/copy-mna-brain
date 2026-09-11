import { resolveFundVehiclesEnabled } from '@/lib/features/fundVehicles';
vi.mock('@/lib/features/fundVehicles', () => ({ resolveFundVehiclesEnabled: vi.fn().mockResolvedValue(true) }));
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlFundRepository } from './flFundRepository';
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

describe('FlFundRepository', () => {
  let mockDb: MockDb;
  let repo: FlFundRepository;

  beforeEach(() => {
    vi.mocked(resolveFundVehiclesEnabled).mockResolvedValue(true);
    mockDb = createMockDb();
    repo = new FlFundRepository(mockDb as never);
  });

  describe('flag disabled', () => {
    beforeEach(() => vi.mocked(resolveFundVehiclesEnabled).mockResolvedValue(false));

    it('rejects unmanaged inserts through every entry point', async () => {
      const input = { workspace_id: 'ws-1', name: 'External', canonical_name: 'external', ownership_basis: 'units' as const };
      await expect(repo.create(input)).rejects.toThrow('disabled');
      await expect(repo.insert(input)).rejects.toThrow('disabled');
      await expect(repo.insertOnConflictDoNothing(input)).rejects.toThrow('disabled');
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('rejects unmanaged updates and attempts to bypass the guard by promoting them', async () => {
      mockDb.limit.mockResolvedValue([{ id: 'external', managed: false }]);
      await expect(repo.update('ws-1', 'external', { name: 'Changed' })).rejects.toThrow('disabled');
      await expect(repo.update('ws-1', 'external', { managed: true })).rejects.toThrow('disabled');
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('allows managed creation and updates but prevents demotion', async () => {
      mockDb.returning.mockResolvedValue([{ id: 'managed', managed: true }]);
      mockDb.limit.mockResolvedValue([{ id: 'managed', managed: true }]);
      await expect(repo.create({ workspace_id: 'ws-1', name: 'Managed', canonical_name: 'managed', managed: true, ownership_basis: 'commitment' })).resolves.toMatchObject({ id: 'managed' });
      await expect(repo.update('ws-1', 'managed', { name: 'Changed' })).resolves.toMatchObject({ id: 'managed' });
      await expect(repo.update('ws-1', 'managed', { managed: false })).rejects.toThrow('disabled');
    });
  });

  describe('create and insert', () => {
    it('creates a fund record and returns it', async () => {
      const fund = { id: 'f-1', workspace_id: 'ws-1', name: 'Fund I', ownership_basis: 'commitment' };
      mockDb.returning.mockResolvedValueOnce([fund]);

      const result = await repo.create({
        workspace_id: 'ws-1',
        name: 'Fund I',
        ownership_basis: 'commitment',
      } as never);

      expect(result).toEqual(fund);
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });

    it('insert delegates to create with supplied executor', async () => {
      const executorMock = createMockDb();
      const fund = { id: 'f-2', workspace_id: 'ws-1', name: 'Fund II', ownership_basis: 'units' };
      executorMock.returning.mockResolvedValueOnce([fund]);

      const result = await repo.insert(
        { workspace_id: 'ws-1', name: 'Fund II', ownership_basis: 'units' } as never,
        executorMock as unknown as DbClient,
      );

      expect(result).toEqual(fund);
      expect(executorMock.insert).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('returns fund by workspaceId and id when found', async () => {
      const fund = { id: 'f-1', workspace_id: 'ws-1', name: 'Fund I' };
      mockDb.limit.mockResolvedValueOnce([fund]);

      const result = await repo.findById('ws-1', 'f-1');
      expect(result).toEqual(fund);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      const fund = { id: 'f-1', workspace_id: 'ws-1', name: 'Fund I' };
      executorMock.limit.mockResolvedValueOnce([fund]);

      const result = await repo.findById('ws-1', 'f-1', executorMock as unknown as DbClient);
      expect(result).toEqual(fund);
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

    it('returns funds matching ids list scoped to workspace', async () => {
      const funds = [{ id: 'f-1', name: 'Fund I' }, { id: 'f-2', name: 'Fund II' }];
      mockDb.orderBy.mockResolvedValueOnce(funds);

      const result = await repo.findByIds('ws-1', ['f-1', 'f-2']);
      expect(result).toEqual(funds);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('findByWorkspaceId', () => {
    it('returns all funds in workspace ordered by name and id', async () => {
      const funds = [{ id: 'f-1', name: 'Fund I' }, { id: 'f-2', name: 'Fund II' }];
      mockDb.orderBy.mockResolvedValueOnce(funds);

      const result = await repo.findByWorkspaceId('ws-1');
      expect(result).toEqual(funds);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('update', () => {
    it('updates fund scoped by workspace and returns updated row', async () => {
      const updated = { id: 'f-1', workspace_id: 'ws-1', name: 'Fund I Updated' };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const result = await repo.update('ws-1', 'f-1', { name: 'Fund I Updated' } as never);
      expect(result).toEqual(updated);
      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('delete', () => {
    it('deletes fund by workspace and id', async () => {
      mockDb.where.mockResolvedValueOnce(undefined);
      await repo.delete('ws-1', 'f-1');
      expect(mockDb.delete).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });
});
