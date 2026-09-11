import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlInvestorRepository } from './flInvestorRepository';
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

describe('FlInvestorRepository', () => {
  let mockDb: MockDb;
  let repo: FlInvestorRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new FlInvestorRepository(mockDb as never);
  });

  describe('create and insert', () => {
    it('creates an investor row and returns it', async () => {
      const row = { id: 'inv-1', workspace_id: 'ws-1', name: 'Alpha LP', investor_type: 'institution' };
      mockDb.returning.mockResolvedValueOnce([row]);

      const result = await repo.create({
        workspace_id: 'ws-1',
        name: 'Alpha LP',
        investor_type: 'institution',
      } as never);

      expect(result).toEqual(row);
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });

    it('insert delegates to create and respects supplied executor', async () => {
      const executorMock = createMockDb();
      const row = { id: 'inv-2', workspace_id: 'ws-1', name: 'Beta LP', investor_type: 'individual' };
      executorMock.returning.mockResolvedValueOnce([row]);

      const result = await repo.insert(
        { workspace_id: 'ws-1', name: 'Beta LP', investor_type: 'individual' } as never,
        executorMock as unknown as DbClient,
      );

      expect(result).toEqual(row);
      expect(executorMock.insert).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('returns investor by workspaceId and id when found', async () => {
      const row = { id: 'inv-1', workspace_id: 'ws-1', name: 'Alpha LP' };
      mockDb.limit.mockResolvedValueOnce([row]);

      const result = await repo.findById('ws-1', 'inv-1');
      expect(result).toEqual(row);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      const row = { id: 'inv-1', workspace_id: 'ws-1', name: 'Alpha LP' };
      executorMock.limit.mockResolvedValueOnce([row]);

      const result = await repo.findById('ws-1', 'inv-1', executorMock as unknown as DbClient);
      expect(result).toEqual(row);
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

    it('returns matching rows scoped to workspace when ids are provided', async () => {
      const rows = [{ id: 'inv-1', name: 'Alpha LP' }, { id: 'inv-2', name: 'Beta LP' }];
      mockDb.orderBy.mockResolvedValueOnce(rows);

      const result = await repo.findByIds('ws-1', ['inv-1', 'inv-2']);
      expect(result).toEqual(rows);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('findByWorkspaceId', () => {
    it('returns investors for given workspace ordered by name and id', async () => {
      const rows = [{ id: 'inv-1', name: 'Alpha LP' }, { id: 'inv-2', name: 'Beta LP' }];
      mockDb.orderBy.mockResolvedValueOnce(rows);

      const result = await repo.findByWorkspaceId('ws-1');
      expect(result).toEqual(rows);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('update', () => {
    it('updates investor scoped by workspace and returns updated row', async () => {
      const updated = { id: 'inv-1', workspace_id: 'ws-1', name: 'Updated LP' };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const result = await repo.update('ws-1', 'inv-1', { name: 'Updated LP' } as never);
      expect(result).toEqual(updated);
      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('delete', () => {
    it('deletes investor by workspace and id', async () => {
      mockDb.where.mockResolvedValueOnce(undefined);
      await repo.delete('ws-1', 'inv-1');
      expect(mockDb.delete).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });
});
