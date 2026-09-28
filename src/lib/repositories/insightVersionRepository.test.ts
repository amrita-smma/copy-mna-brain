import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { InsightVersionRepository } from './insightVersionRepository';
import { insights, insightVersions } from '@/lib/db/schema';
import type { DbClient } from './types';

const CHAIN = ['select', 'from', 'where', 'orderBy', 'limit', 'innerJoin', 'groupBy', 'insert', 'values'] as const;
type MockDb = Record<(typeof CHAIN)[number] | 'returning', ReturnType<typeof vi.fn>>;

function createMockDb(): MockDb {
  const mock = { returning: vi.fn() } as MockDb;
  for (const k of CHAIN) mock[k] = vi.fn().mockReturnThis();
  return mock;
}

const toSql = (c: unknown) => new PgDialect().sqlToQuery(c as SQL);

describe('InsightVersionRepository', () => {
  let mockDb: MockDb;
  let repo: InsightVersionRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new InsightVersionRepository(mockDb as never);
  });

  describe('InsightVersionRepository.findCurrent', () => {
    it('returns highest version_no row for insight', async () => {
      mockDb.limit.mockResolvedValueOnce([{ version_no: 2 }]);

      expect(await repo.findCurrent('art-1', 'ws-1')).toEqual({ version_no: 2 });
      expect(mockDb.from).toHaveBeenCalledWith(insightVersions);
      expect(mockDb.orderBy).toHaveBeenCalledTimes(1);
      expect(mockDb.limit).toHaveBeenCalledWith(1);
    });

    it('returns undefined when no versions exist', async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      expect(await repo.findCurrent('art-empty', 'ws-1')).toBeUndefined();
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      executorMock.limit.mockResolvedValueOnce([{ version_no: 1 }]);

      await repo.findCurrent('art-1', 'ws-1', executorMock as unknown as DbClient);

      expect(executorMock.select).toHaveBeenCalledTimes(1);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe('InsightVersionRepository.findCurrentHead', () => {
    it("returns the highest version's id, number, publish time and trigger without its HTML", async () => {
      const head = { id: 'v-2', version_no: 2, created_at: '2026-09-24T00:00:00Z', trigger: 'routine' };
      mockDb.limit.mockResolvedValueOnce([head]);

      expect(await repo.findCurrentHead('art-1', 'ws-1')).toEqual(head);
      const selection = mockDb.select.mock.calls[0][0] as Record<string, unknown>;
      expect(Object.keys(selection).sort()).toEqual(['created_at', 'id', 'trigger', 'version_no']);
      expect(mockDb.limit).toHaveBeenCalledWith(1);
    });
  });

  describe('InsightVersionRepository.findByInsightId', () => {
    it('selects the agent stamp column for the version history', async () => {
      const versions = [{ id: 'v-2' }, { id: 'v-1' }];
      mockDb.orderBy.mockResolvedValueOnce(versions);

      expect(await repo.findByInsightId('art-1', 'ws-1')).toEqual(versions);
      const projection = mockDb.select.mock.calls[0][0] as Record<string, unknown>;
      expect(projection.agent_key).toBe(insightVersions.agent_key);
      expect(mockDb.orderBy).toHaveBeenCalledTimes(1);
    });
  });

  describe('InsightVersionRepository.findByVersionNo', () => {
    it('returns specific version by version_no', async () => {
      const executorMock = createMockDb();
      const version = { id: 'v-1', version_no: 1 };
      executorMock.limit.mockResolvedValueOnce([version]);

      expect(await repo.findByVersionNo('art-1', 'ws-1', 1, executorMock as unknown as DbClient)).toEqual(version);
      expect(executorMock.limit).toHaveBeenCalledWith(1);
      expect(mockDb.select).not.toHaveBeenCalled();
    });
  });

  describe('InsightVersionRepository.findRoutineVersionBySourceRunId', () => {
    it('returns the row when found', async () => {
      const row = { id: 'v-1', version_no: 2, insight_id: 'art-1' };
      mockDb.limit.mockResolvedValueOnce([row]);

      expect(await repo.findRoutineVersionBySourceRunId('run-1', 'ws-1')).toEqual(row);
      const where = toSql(mockDb.where.mock.calls[0][0]);
      expect(where.params).toEqual(expect.arrayContaining(['ws-1', 'run-1', 'routine']));
    });

    it('returns undefined when no matching routine version exists', async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      expect(await repo.findRoutineVersionBySourceRunId('run-missing', 'ws-1')).toBeUndefined();
    });
  });

  describe('InsightVersionRepository.findLatestBySourceRunId', () => {
    it('joins the insight for its name and scopes both tables to the workspace', async () => {
      const row = { insight_id: 'art-1', insight_name: 'Q3', version_no: 4, is_unchanged: false };
      mockDb.limit.mockResolvedValueOnce([row]);

      expect(await repo.findLatestBySourceRunId('run-1', 'ws-1')).toEqual(row);
      const [joinTable, joinOn] = mockDb.innerJoin.mock.calls[0];
      expect(joinTable).toBe(insights);
      const join = toSql(joinOn);
      expect(join.params).toContain('ws-1');
      expect(join.sql).toContain('"archived_at" is null');
      const where = toSql(mockDb.where.mock.calls[0][0]);
      expect(where.params).toEqual(expect.arrayContaining(['ws-1', 'run-1']));
      expect(where.sql).toContain('"source_run_id" =');
    });

    it('orders newest version first by time', async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await expect(repo.findLatestBySourceRunId('run-1', 'ws-1')).resolves.toBeUndefined();
      expect(toSql(mockDb.orderBy.mock.calls[0][0]).sql).toContain('"created_at" desc');
    });
  });

  describe('InsightVersionRepository.findLatestVersionNosByInsightIds', () => {
    it('returns empty map if given empty array without querying database', async () => {
      expect((await repo.findLatestVersionNosByInsightIds([], 'ws-1')).size).toBe(0);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('returns map of insightId to latestVersionNo', async () => {
      mockDb.groupBy.mockResolvedValueOnce([
        { insightId: 'art-1', latestVersionNo: 3 },
        { insightId: 'art-2', latestVersionNo: 1 },
      ]);

      const result = await repo.findLatestVersionNosByInsightIds(['art-1', 'art-2'], 'ws-1');

      expect([...result]).toEqual([['art-1', 3], ['art-2', 1]]);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
    });
  });

  describe('InsightVersionRepository.create', () => {
    it('creates version and returns inserted row', async () => {
      const executorMock = createMockDb();
      const input = { workspace_id: 'ws-1', insight_id: 'art-1', version_no: 1, html: '<p>v1</p>', trigger: 'copilot_create' };
      const created = { id: 'v-1', ...input };
      executorMock.returning.mockResolvedValueOnce([created]);

      expect(await repo.create(input as never, executorMock as unknown as DbClient)).toEqual(created);
      expect(executorMock.insert).toHaveBeenCalledWith(insightVersions);
      expect(executorMock.values).toHaveBeenCalledWith(input);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });
});
