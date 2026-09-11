import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FlSourceRecordRepository } from './flSourceRecordRepository';
import type { DbClient } from './types';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  onConflictDoNothing: ReturnType<typeof vi.fn>;
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
    onConflictDoNothing: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  };
  return mock;
}

describe('FlSourceRecordRepository', () => {
  let mockDb: MockDb;
  let repo: FlSourceRecordRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new FlSourceRecordRepository(mockDb as never);
  });

  describe('create and insert', () => {
    it('creates a source record and returns it', async () => {
      const record = {
        id: 'sr-1',
        workspace_id: 'ws-1',
        file_id: 'file-1',
        payload_hash: 'hash123',
        raw_payload: { foo: 'bar' },
      };
      mockDb.returning.mockResolvedValueOnce([record]);

      const result = await repo.create(record as never);
      expect(result).toEqual(record);
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
    });

    it('insert delegates to create and respects supplied executor', async () => {
      const executorMock = createMockDb();
      const record = { id: 'sr-2', workspace_id: 'ws-1' };
      executorMock.returning.mockResolvedValueOnce([record]);

      const result = await repo.insert(record as never, executorMock as unknown as DbClient);
      expect(result).toEqual(record);
      expect(executorMock.insert).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe('findById', () => {
    it('returns source record by workspaceId and id when found', async () => {
      const record = { id: 'sr-1', workspace_id: 'ws-1' };
      mockDb.limit.mockResolvedValueOnce([record]);

      const result = await repo.findById('ws-1', 'sr-1');
      expect(result).toEqual(record);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      const record = { id: 'sr-1', workspace_id: 'ws-1' };
      executorMock.limit.mockResolvedValueOnce([record]);

      const result = await repo.findById('ws-1', 'sr-1', executorMock as unknown as DbClient);
      expect(result).toEqual(record);
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

    it('returns source records matching ids scoped to workspace', async () => {
      const records = [{ id: 'sr-1' }, { id: 'sr-2' }];
      mockDb.orderBy.mockResolvedValueOnce(records);

      const result = await repo.findByIds('ws-1', ['sr-1', 'sr-2']);
      expect(result).toEqual(records);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('findByWorkspaceId', () => {
    it('returns source records for workspace ordered by imported_at desc and id', async () => {
      const records = [{ id: 'sr-1' }, { id: 'sr-2' }];
      mockDb.orderBy.mockResolvedValueOnce(records);

      const result = await repo.findByWorkspaceId('ws-1');
      expect(result).toEqual(records);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('upsertByHash', () => {
    it('inserts and returns newly created record when no conflict', async () => {
      const record = {
        id: 'sr-1',
        workspace_id: 'ws-1',
        file_id: 'file-1',
        sheet_name: 'Sheet1',
        row_number: 2,
        payload_hash: 'hash123',
        raw_payload: { foo: 'bar' },
      };
      mockDb.returning.mockResolvedValueOnce([record]);

      const result = await repo.upsertByHash(record as never);
      expect(result).toEqual(record);
      expect(mockDb.onConflictDoNothing).toHaveBeenCalledTimes(1);
    });

    it('returns existing record when conflict occurs', async () => {
      const input = {
        workspace_id: 'ws-1',
        file_id: 'file-1',
        sheet_name: 'Sheet1',
        row_number: 2,
        payload_hash: 'hash123',
        raw_payload: { foo: 'bar' },
      };
      const existing = { id: 'sr-existing', ...input };

      mockDb.returning.mockResolvedValueOnce([]);
      mockDb.limit.mockResolvedValueOnce([existing]);

      const result = await repo.upsertByHash(input as never);
      expect(result).toEqual(existing);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });

    it('handles nullable sheet_name and row_number on conflict query', async () => {
      const input = {
        workspace_id: 'ws-1',
        file_id: 'file-1',
        payload_hash: 'hash123',
        raw_payload: { foo: 'bar' },
      };
      const existing = { id: 'sr-existing', ...input, sheet_name: null, row_number: null };

      mockDb.returning.mockResolvedValueOnce([]);
      mockDb.limit.mockResolvedValueOnce([existing]);

      const result = await repo.upsertByHash(input as never);
      expect(result).toEqual(existing);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      const record = {
        id: 'sr-1',
        workspace_id: 'ws-1',
        file_id: 'file-1',
        payload_hash: 'hash123',
        raw_payload: { foo: 'bar' },
      };
      executorMock.returning.mockResolvedValueOnce([record]);

      const result = await repo.upsertByHash(record as never, executorMock as unknown as DbClient);
      expect(result).toEqual(record);
      expect(executorMock.insert).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe('update and delete', () => {
    it('updates source record scoped by workspace and returns updated row', async () => {
      const updated = { id: 'sr-1', workspace_id: 'ws-1', payload_hash: 'new-hash' };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const result = await repo.update('ws-1', 'sr-1', { payload_hash: 'new-hash' } as never);
      expect(result).toEqual(updated);
      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });

    it('deletes source record by workspace and id', async () => {
      mockDb.where.mockResolvedValueOnce(undefined);
      await repo.delete('ws-1', 'sr-1');
      expect(mockDb.delete).toHaveBeenCalledTimes(1);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });
});
