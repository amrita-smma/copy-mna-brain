import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlFundingSourceRepository } from './flFundingSourceRepository';
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

describe('FlFundingSourceRepository', () => {
  let mockDb: MockDb;
  let repo: FlFundingSourceRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new FlFundingSourceRepository(mockDb as never);
  });

  describe('create and insert', () => {
    it('creates a funding source record and returns it', async () => {
      const source = { id: 'fs-1', workspace_id: 'ws-1', name: 'Main LP Pool', currency: 'USD' };
      mockDb.returning.mockResolvedValueOnce([source]);

      const result = await repo.create({
        workspace_id: 'ws-1',
        name: 'Main LP Pool',
        currency: 'USD',
      } as never);

      expect(result).toEqual(source);
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });

    it('insert delegates to create and respects supplied executor', async () => {
      const executorMock = createMockDb();
      const source = { id: 'fs-2', workspace_id: 'ws-1', name: 'Co-invest Pool', currency: 'USD' };
      executorMock.returning.mockResolvedValueOnce([source]);

      const result = await repo.insert(
        { workspace_id: 'ws-1', name: 'Co-invest Pool', currency: 'USD' } as never,
        executorMock as unknown as DbClient,
      );

      expect(result).toEqual(source);
      expect(executorMock.insert).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('returns funding source by workspaceId and id when found', async () => {
      const source = { id: 'fs-1', workspace_id: 'ws-1', name: 'Main LP Pool' };
      mockDb.limit.mockResolvedValueOnce([source]);

      const result = await repo.findById('ws-1', 'fs-1');
      expect(result).toEqual(source);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      const source = { id: 'fs-1', workspace_id: 'ws-1', name: 'Main LP Pool' };
      executorMock.limit.mockResolvedValueOnce([source]);

      const result = await repo.findById('ws-1', 'fs-1', executorMock as unknown as DbClient);
      expect(result).toEqual(source);
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

    it('returns funding sources matching ids list scoped to workspace', async () => {
      const sources = [{ id: 'fs-1', name: 'Pool 1' }, { id: 'fs-2', name: 'Pool 2' }];
      mockDb.orderBy.mockResolvedValueOnce(sources);

      const result = await repo.findByIds('ws-1', ['fs-1', 'fs-2']);
      expect(result).toEqual(sources);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('findByWorkspaceId', () => {
    it('returns all funding sources in workspace ordered by name and id', async () => {
      const sources = [{ id: 'fs-1', name: 'Pool 1' }, { id: 'fs-2', name: 'Pool 2' }];
      mockDb.orderBy.mockResolvedValueOnce(sources);

      const result = await repo.findByWorkspaceId('ws-1');
      expect(result).toEqual(sources);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('update', () => {
    it('updates funding source scoped by workspace and returns updated row', async () => {
      const updated = { id: 'fs-1', workspace_id: 'ws-1', name: 'Pool 1 Updated' };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const result = await repo.update('ws-1', 'fs-1', { name: 'Pool 1 Updated' } as never);
      expect(result).toEqual(updated);
      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('delete', () => {
    it('deletes funding source by workspace and id', async () => {
      mockDb.where.mockResolvedValueOnce(undefined);
      await repo.delete('ws-1', 'fs-1');
      expect(mockDb.delete).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });
});
