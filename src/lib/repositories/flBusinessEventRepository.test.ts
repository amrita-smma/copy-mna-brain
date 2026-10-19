import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlBusinessEventRepository } from './flBusinessEventRepository';
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

describe('FlBusinessEventRepository', () => {
  let mockDb: MockDb;
  let repo: FlBusinessEventRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new FlBusinessEventRepository(mockDb as never);
  });

  describe('create and insert', () => {
    it('creates a business event record and returns it', async () => {
      const event = {
        id: 'be-1',
        workspace_id: 'ws-1',
        event_type: 'capital_call',
        event_date: '2026-01-15',
        status: 'posted',
      };
      mockDb.returning.mockResolvedValueOnce([event]);

      const result = await repo.create({
        workspace_id: 'ws-1',
        event_type: 'capital_call',
        event_date: '2026-01-15',
      } as never);

      expect(result).toEqual(event);
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });

    it('insert delegates to create and respects supplied executor', async () => {
      const executorMock = createMockDb();
      const event = { id: 'be-2', workspace_id: 'ws-1', event_type: 'distribution' };
      executorMock.returning.mockResolvedValueOnce([event]);

      const result = await repo.insert(
        { workspace_id: 'ws-1', event_type: 'distribution' } as never,
        executorMock as unknown as DbClient,
      );

      expect(result).toEqual(event);
      expect(executorMock.insert).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('returns event by workspaceId and id when found', async () => {
      const event = { id: 'be-1', workspace_id: 'ws-1', event_type: 'capital_call' };
      mockDb.limit.mockResolvedValueOnce([event]);

      const result = await repo.findById('ws-1', 'be-1');
      expect(result).toEqual(event);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      const event = { id: 'be-1', workspace_id: 'ws-1', event_type: 'capital_call' };
      executorMock.limit.mockResolvedValueOnce([event]);

      const result = await repo.findById('ws-1', 'be-1', executorMock as unknown as DbClient);
      expect(result).toEqual(event);
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

    it('returns business events matching ids list scoped to workspace', async () => {
      const events = [{ id: 'be-1' }, { id: 'be-2' }];
      mockDb.orderBy.mockResolvedValueOnce(events);

      const result = await repo.findByIds('ws-1', ['be-1', 'be-2']);
      expect(result).toEqual(events);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('findByWorkspaceId', () => {
    it('returns business events ordered by event_date desc and id', async () => {
      const events = [{ id: 'be-1' }, { id: 'be-2' }];
      mockDb.orderBy.mockResolvedValueOnce(events);

      const result = await repo.findByWorkspaceId('ws-1');
      expect(result).toEqual(events);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('markReversed', () => {
    it('updates event status to reversed scoped to workspace', async () => {
      const reversed = { id: 'be-1', workspace_id: 'ws-1', status: 'reversed' };
      mockDb.returning.mockResolvedValueOnce([reversed]);

      const result = await repo.markReversed('ws-1', 'be-1');
      expect(result).toEqual(reversed);
      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('update and delete', () => {
    it('updates event scoped by workspace and returns updated row', async () => {
      const updated = { id: 'be-1', workspace_id: 'ws-1', notes: 'Updated notes' };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const result = await repo.update('ws-1', 'be-1', { notes: 'Updated notes' } as never);
      expect(result).toEqual(updated);
      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });

    it('deletes event by workspace and id', async () => {
      mockDb.where.mockResolvedValueOnce(undefined);
      await repo.delete('ws-1', 'be-1');
      expect(mockDb.delete).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('FlBusinessEventRepository.deleteByIds', () => {
    it('returns 0 without hitting the DB when the id list is empty', async () => {
      const mockDb = createMockDb();
      const repo = new FlBusinessEventRepository(mockDb as never);
      const result = await repo.deleteByIds('ws-1', []);
      expect(result).toBe(0);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });

    it('deletes workspace-scoped events and returns how many were removed', async () => {
      const mockDb = createMockDb();
      const repo = new FlBusinessEventRepository(mockDb as never);
      mockDb.returning.mockResolvedValueOnce([{ id: 'be-1' }, { id: 'be-2' }]);
      const result = await repo.deleteByIds('ws-1', ['be-1', 'be-2']);
      expect(result).toBe(2);
      expect(mockDb.delete).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });
});
