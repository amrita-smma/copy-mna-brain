import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlBusinessEventRevisionRepository } from './flBusinessEventRevisionRepository';
import type { DbClient } from './types';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
}

function createMockDb(): MockDb {
  const mock: MockDb = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
  };
  return mock;
}

describe('FlBusinessEventRevisionRepository', () => {
  let mockDb: MockDb;
  let repo: FlBusinessEventRevisionRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new FlBusinessEventRevisionRepository(mockDb as never);
  });

  describe('create', () => {
    it('creates a revision record and returns it', async () => {
      const revision = {
        id: 'rev-1',
        workspace_id: 'ws-1',
        business_event_id: 'be-1',
        revision_no: 1,
        snapshot: {
          event: { id: 'be-1' },
          entries: [],
          allocations: [],
        },
        changed_by: 'user-1',
        changed_at: '2026-09-04T00:00:00.000Z',
      };
      mockDb.returning.mockResolvedValueOnce([revision]);

      const result = await repo.create({
        workspace_id: 'ws-1',
        business_event_id: 'be-1',
        revision_no: 1,
        snapshot: revision.snapshot,
        changed_by: 'user-1',
      } as never);

      expect(result).toEqual(revision);
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
      expect(mockDb.values).toHaveBeenCalledWith({
        workspace_id: 'ws-1',
        business_event_id: 'be-1',
        revision_no: 1,
        snapshot: revision.snapshot,
        changed_by: 'user-1',
      });
      expect(mockDb.returning).toHaveBeenCalledTimes(1);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      const revision = { id: 'rev-2', workspace_id: 'ws-1', revision_no: 2 };
      executorMock.returning.mockResolvedValueOnce([revision]);

      const result = await repo.create(
        { workspace_id: 'ws-1', business_event_id: 'be-1', revision_no: 2 } as never,
        executorMock as unknown as DbClient,
      );

      expect(result).toEqual(revision);
      expect(executorMock.insert).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe('findByBusinessEventId', () => {
    it('returns revisions ordered by revision_no ascending', async () => {
      const revisions = [
        { id: 'rev-1', business_event_id: 'be-1', revision_no: 1 },
        { id: 'rev-2', business_event_id: 'be-1', revision_no: 2 },
      ];
      mockDb.orderBy.mockResolvedValueOnce(revisions);

      const result = await repo.findByBusinessEventId('ws-1', 'be-1');
      expect(result).toEqual(revisions);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
      expect(mockDb.from).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
      expect(mockDb.orderBy).toHaveBeenCalledTimes(1);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      const revisions = [{ id: 'rev-1', business_event_id: 'be-1', revision_no: 1 }];
      executorMock.orderBy.mockResolvedValueOnce(revisions);

      const result = await repo.findByBusinessEventId(
        'ws-1',
        'be-1',
        executorMock as unknown as DbClient,
      );

      expect(result).toEqual(revisions);
      expect(executorMock.select).toHaveBeenCalledTimes(1);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe('nextRevisionNo', () => {
    it('returns incremented revision_no from aggregate query', async () => {
      mockDb.where.mockResolvedValueOnce([{ next: 3 }]);

      const result = await repo.nextRevisionNo('ws-1', 'be-1');
      expect(result).toBe(3);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
      expect(mockDb.from).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });

    it('returns 1 when the aggregate comes back null', async () => {
      mockDb.where.mockResolvedValueOnce([{ next: null }]);

      const result = await repo.nextRevisionNo('ws-1', 'be-1');
      expect(result).toBe(1);
    });

    it('returns 1 when result is empty', async () => {
      mockDb.where.mockResolvedValueOnce([]);

      const result = await repo.nextRevisionNo('ws-1', 'be-1');
      expect(result).toBe(1);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      executorMock.where.mockResolvedValueOnce([{ next: 2 }]);

      const result = await repo.nextRevisionNo(
        'ws-1',
        'be-1',
        executorMock as unknown as DbClient,
      );

      expect(result).toBe(2);
      expect(executorMock.select).toHaveBeenCalledTimes(1);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });
});
