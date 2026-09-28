import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { InsightRunDraftRepository } from './insightRunDraftRepository';
import { insightRunDrafts } from '@/lib/db/schema';
import type { DbClient } from './types';

const CHAIN = ['select', 'from', 'where', 'limit', 'insert', 'values', 'onConflictDoUpdate', 'delete'] as const;
type MockDb = Record<(typeof CHAIN)[number] | 'returning', ReturnType<typeof vi.fn>>;

function createMockDb(): MockDb {
  const mock = { returning: vi.fn() } as MockDb;
  for (const k of CHAIN) mock[k] = vi.fn().mockReturnThis();
  return mock;
}

const whereParams = (db: MockDb) => new PgDialect().sqlToQuery(db.where.mock.calls[0][0] as SQL).params;

describe('InsightRunDraftRepository', () => {
  let mockDb: MockDb;
  let repo: InsightRunDraftRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new InsightRunDraftRepository(mockDb as unknown as DbClient);
  });

  describe('InsightRunDraftRepository.findByRunId', () => {
    it('findByRunId filters run + workspace and returns undefined when missing', async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      expect(await repo.findByRunId('run-1', 'ws-1')).toBeUndefined();
      expect(mockDb.from).toHaveBeenCalledWith(insightRunDrafts);
      expect(whereParams(mockDb)).toEqual(expect.arrayContaining(['run-1', 'ws-1']));
      expect(mockDb.limit).toHaveBeenCalledWith(1);
    });

    it('returns the row when found and respects custom executor', async () => {
      const draft = { run_id: 'run-1', html: '<p>draft</p>' };
      const executor = createMockDb();
      executor.limit.mockResolvedValueOnce([draft]);

      expect(await repo.findByRunId('run-1', 'ws-1', executor as unknown as DbClient)).toEqual(draft);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe('InsightRunDraftRepository.upsert', () => {
    it('upsert inserts with onConflictDoUpdate whose set contains html and NOT base_version_no/insight_id', async () => {
      const input = { run_id: 'run-1', workspace_id: 'ws-1', insight_id: 'art-1', base_version_no: 2, html: '<p>updated draft</p>' };
      const saved = { ...input, created_at: '2026-09-24T00:00:00Z', updated_at: '2026-09-24T00:01:00Z' };
      mockDb.returning.mockResolvedValueOnce([saved]);

      expect(await repo.upsert(input)).toEqual(saved);
      expect(mockDb.insert).toHaveBeenCalledWith(insightRunDrafts);
      expect(mockDb.values).toHaveBeenCalledWith(input);

      const conflictArg = mockDb.onConflictDoUpdate.mock.calls[0][0];
      expect(conflictArg.target).toBe(insightRunDrafts.run_id);
      expect(Object.keys(conflictArg.set).sort()).toEqual(['html', 'updated_at']);
      expect(conflictArg.set.html).toBe(input.html);
    });
  });

  describe('InsightRunDraftRepository.deleteByRunId', () => {
    it('deleteByRunId scopes by run + workspace', async () => {
      const executor = createMockDb();

      await repo.deleteByRunId('run-1', 'ws-1', executor as unknown as DbClient);

      expect(executor.delete).toHaveBeenCalledWith(insightRunDrafts);
      expect(whereParams(executor)).toEqual(expect.arrayContaining(['run-1', 'ws-1']));
      expect(mockDb.delete).not.toHaveBeenCalled();
    });
  });
});
