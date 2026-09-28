import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InsightRepository, escapeLikePattern } from './insightRepository';
import { insights, users } from '@/lib/db/schema';
import type { DbClient } from './types';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const CHAIN = ['select', 'from', 'leftJoin', 'where', 'orderBy', 'limit', 'offset', 'insert', 'values', 'update', 'set', 'delete'] as const;
type MockDb = Record<(typeof CHAIN)[number] | 'for' | 'returning' | 'groupBy', ReturnType<typeof vi.fn>>;

const dialect = new PgDialect();
const toQuery = (fragment: unknown) => dialect.sqlToQuery(fragment as SQL);

function createMockDb(): MockDb {
  const mock = { for: vi.fn(), returning: vi.fn(), groupBy: vi.fn() } as MockDb;
  for (const k of CHAIN) mock[k] = vi.fn().mockReturnThis();
  return mock;
}

describe('InsightRepository', () => {
  let mockDb: MockDb;
  let repo: InsightRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new InsightRepository(mockDb as never);
  });

  describe('InsightRepository.findByWorkspaceId', () => {
    it('returns non-archived insights for workspace ordered newest first', async () => {
      const items = [{ id: 'art-1' }, { id: 'art-2' }];
      mockDb.orderBy.mockResolvedValueOnce(items);

      expect(await repo.findByWorkspaceId('ws-1')).toEqual(items);
      expect(mockDb.from).toHaveBeenCalledWith(insights);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
      expect(mockDb.orderBy).toHaveBeenCalledTimes(1);
    });
  });

  describe('escapeLikePattern', () => {
    it('escapes backslash first, then % and _, so they match literally', () => {
      expect(escapeLikePattern('50%_off\\now')).toBe('50\\%\\_off\\\\now');
      expect(escapeLikePattern('plain')).toBe('plain');
    });
  });

  describe('InsightRepository.findPageWithCreator', () => {
    const page = { limit: 50, offset: 0 };
    const whereOf = () => toQuery(mockDb.where.mock.calls[0][0]);
    const orderOf = () =>
      mockDb.orderBy.mock.calls[0].map((part: unknown) => toQuery(part).sql);

    it('returns one page of live insights with the creator name, in one query', async () => {
      const items = [{ id: 'art-1', created_by_name: 'Alice' }];
      mockDb.offset.mockResolvedValueOnce(items);

      expect(await repo.findPageWithCreator('ws-1', {}, { limit: 25, offset: 50 })).toEqual(items);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
      const projection = mockDb.select.mock.calls[0][0] as Record<string, unknown>;
      expect(projection.agent_key).toBe(insights.agent_key);
      expect(projection.source_template_id).toBe(insights.source_template_id);
      expect(projection.created_by_name).toBe(users.name);
      expect(mockDb.leftJoin).toHaveBeenCalledWith(users, expect.anything());
      expect(mockDb.limit).toHaveBeenCalledWith(25);
      expect(mockDb.offset).toHaveBeenCalledWith(50);
      const q = whereOf();
      expect(q.params).toEqual(['ws-1']);
      expect(q.sql).toContain('"insights"."archived_at" is null');
    });

    it('orders live insights featured first, then newest updated, then id', async () => {
      mockDb.offset.mockResolvedValueOnce([]);
      await repo.findPageWithCreator('ws-1', {}, page);
      expect(orderOf()).toEqual([
        '"insights"."is_featured" desc',
        '"insights"."updated_at" desc',
        '"insights"."id" asc',
      ]);
    });

    it('lists archived insights newest updated first, ignoring featured', async () => {
      mockDb.offset.mockResolvedValueOnce([]);
      await repo.findPageWithCreator('ws-1', { archived: true }, page);
      expect(whereOf().sql).toContain('"insights"."archived_at" is not null');
      expect(orderOf()).toEqual(['"insights"."updated_at" desc', '"insights"."id" asc']);
    });

    it('searches name and description case-insensitively, with wildcards escaped', async () => {
      mockDb.offset.mockResolvedValueOnce([]);
      await repo.findPageWithCreator('ws-1', { q: '  100%_ ' }, page);
      const q = whereOf();
      expect(q.sql).toContain('"insights"."name" ilike $2');
      expect(q.sql).toContain('"insights"."description" ilike $3');
      expect(q.params).toEqual(['ws-1', '%100\\%\\_%', '%100\\%\\_%']);
    });

    it('ignores a blank search', async () => {
      mockDb.offset.mockResolvedValueOnce([]);
      await repo.findPageWithCreator('ws-1', { q: '   ' }, page);
      expect(whereOf().sql).not.toContain('ilike');
    });

    it('filters by agent key, and by agent_key IS NULL for the general CoPilot', async () => {
      mockDb.offset.mockResolvedValue([]);
      await repo.findPageWithCreator('ws-1', { agentKey: 'bangun' }, page);
      const bound = whereOf();
      expect(bound.sql).toContain('"insights"."agent_key" = $2');
      expect(bound.params).toEqual(['ws-1', 'bangun']);

      mockDb.where.mockClear();
      await repo.findPageWithCreator('ws-1', { agentKey: null }, page);
      expect(whereOf().sql).toContain('"insights"."agent_key" is null');
    });

    it('filters to one creator', async () => {
      mockDb.offset.mockResolvedValueOnce([]);
      await repo.findPageWithCreator('ws-1', { createdBy: 'u-1' }, page);
      const q = whereOf();
      expect(q.sql).toContain('"insights"."created_by" = $2');
      expect(q.params).toEqual(['ws-1', 'u-1']);
    });
  });

  describe('InsightRepository.countByFilter', () => {
    it('counts with the same WHERE as the page', async () => {
      mockDb.offset.mockResolvedValueOnce([]);
      const filter = { q: 'apac', agentKey: null, createdBy: 'u-1', archived: true };
      await repo.findPageWithCreator('ws-1', filter, { limit: 50, offset: 0 });
      mockDb.where.mockResolvedValueOnce([{ total: 7 }]);

      expect(await repo.countByFilter('ws-1', filter)).toBe(7);
      const [pageWhere, countWhere] = mockDb.where.mock.calls.map((c) => toQuery(c[0]));
      expect(countWhere).toEqual(pageWhere);
    });

    it('returns 0 when the count row is missing', async () => {
      mockDb.where.mockResolvedValueOnce([]);
      expect(await repo.countByFilter('ws-1', {})).toBe(0);
    });
  });

  describe('InsightRepository.countBySourceTemplate', () => {
    it('counts non-archived insights per source template in one grouped query', async () => {
      const rows = [
        { template_id: 'tpl-1', usage_count: 3 },
        { template_id: 'tpl-2', usage_count: 1 },
      ];
      mockDb.groupBy.mockResolvedValueOnce(rows);

      expect(await repo.countBySourceTemplate('ws-1')).toEqual(rows);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
      const projection = mockDb.select.mock.calls[0][0] as Record<string, unknown>;
      expect(projection.template_id).toBe(insights.source_template_id);
      expect(mockDb.from).toHaveBeenCalledWith(insights);
      const q = toQuery(mockDb.where.mock.calls[0][0]);
      expect(q.params).toEqual(['ws-1']);
      expect(q.sql).toContain('"archived_at" is null');
      expect(q.sql).toContain('"source_template_id" is not null');
      expect(mockDb.groupBy).toHaveBeenCalledWith(insights.source_template_id);
    });

    it('returns [] when no insight came from a template', async () => {
      mockDb.groupBy.mockResolvedValueOnce([]);
      expect(await repo.countBySourceTemplate('ws-1')).toEqual([]);
    });
  });

  describe('InsightRepository.findById', () => {
    it('returns insight by id and workspace_id when found', async () => {
      const insight = { id: 'art-1' };
      mockDb.limit.mockResolvedValueOnce([insight]);

      expect(await repo.findById('art-1', 'ws-1')).toEqual(insight);
      expect(mockDb.limit).toHaveBeenCalledWith(1);
    });

    it('returns undefined when no matching insight exists', async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      expect(await repo.findById('art-nonexistent', 'ws-1')).toBeUndefined();
    });
  });

  describe('InsightRepository.lockById', () => {
    it('selects for update to lock the insight row', async () => {
      const insight = { id: 'art-1' };
      mockDb.for.mockResolvedValueOnce([insight]);

      expect(await repo.lockById('art-1', 'ws-1')).toEqual(insight);
      expect(mockDb.limit).toHaveBeenCalledWith(1);
      expect(mockDb.for).toHaveBeenCalledWith('update');
    });

    it('returns undefined when no matching insight exists', async () => {
      mockDb.for.mockResolvedValueOnce([]);
      expect(await repo.lockById('art-nonexistent', 'ws-1')).toBeUndefined();
    });
  });

  describe('InsightRepository.create', () => {
    it('creates an insight record and returns it', async () => {
      const input = { workspace_id: 'ws-1', name: 'Report Analysis', kind: 'report' as const };
      const created = { id: 'art-report', ...input };
      mockDb.returning.mockResolvedValueOnce([created]);

      expect(await repo.create(input as never)).toEqual(created);
      expect(mockDb.insert).toHaveBeenCalledWith(insights);
      expect(mockDb.values).toHaveBeenCalledWith(input);
    });

    it('uses supplied executor when provided', async () => {
      const executorMock = createMockDb();
      executorMock.returning.mockResolvedValueOnce([{ id: 'art-created' }]);

      await repo.create({ workspace_id: 'ws-1', name: 'Custom' } as never, executorMock as unknown as DbClient);

      expect(executorMock.insert).toHaveBeenCalledTimes(1);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe('InsightRepository.update', () => {
    it('updates insight fields, bumps updated_at, and returns updated row', async () => {
      const updated = { id: 'art-1', name: 'Updated Name' };
      mockDb.returning.mockResolvedValueOnce([updated]);

      expect(await repo.update('art-1', 'ws-1', { name: 'Updated Name' })).toEqual(updated);
      expect(mockDb.update).toHaveBeenCalledWith(insights);
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Updated Name', updated_at: expect.anything() }),
      );
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });

    it('writes agent_key, including null to unbind', async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: 'art-1', agent_key: null }]);

      await repo.update('art-1', 'ws-1', { agent_key: null, updated_by: 'u1' });

      expect(mockDb.set).toHaveBeenCalledWith(expect.objectContaining({ agent_key: null, updated_by: 'u1' }));
    });
  });

  describe('InsightRepository.archive', () => {
    it('sets archived_at rather than deleting', async () => {
      const archived = { id: 'art-1', archived_at: '2026-09-20T00:00:00Z' };
      mockDb.returning.mockResolvedValueOnce([archived]);

      expect(await repo.archive('art-1', 'ws-1')).toEqual(archived);
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ archived_at: expect.anything(), updated_at: expect.anything() }),
      );
      expect(mockDb.delete).not.toHaveBeenCalled();
    });
  });

  describe('InsightRepository.unarchive', () => {
    it('clears archived_at and is_featured in the one statement, only on an archived row', async () => {
      const restored = { id: 'art-1', archived_at: null, is_featured: false };
      mockDb.returning.mockResolvedValueOnce([restored]);

      expect(await repo.unarchive('art-1', 'ws-1')).toEqual(restored);
      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(mockDb.set).toHaveBeenCalledTimes(1);
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ archived_at: null, is_featured: false, updated_at: expect.anything() }),
      );
      const q = toQuery(mockDb.where.mock.calls[0][0]);
      expect(q.params).toEqual(['ws-1', 'art-1']);
      expect(q.sql).toContain('"insights"."archived_at" is not null');
    });

    it('returns undefined when no archived row matched', async () => {
      mockDb.returning.mockResolvedValueOnce([]);
      expect(await repo.unarchive('art-1', 'ws-1')).toBeUndefined();
    });
  });

  describe('InsightRepository.hardDelete', () => {
    it.each([
      ['deletes insight and returns true when a row was deleted', [{ id: 'art-1' }], true],
      ['returns false when no matching row was deleted', [], false],
    ])('%s', async (_label, rows, expected) => {
      mockDb.returning.mockResolvedValueOnce(rows);

      expect(await repo.hardDelete('ws-1', 'art-1')).toBe(expected);
      expect(mockDb.delete).toHaveBeenCalledWith(insights);
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });

  describe('InsightRepository.clearFeatured', () => {
    it('unsets is_featured for all featured insights in the workspace', async () => {
      await repo.clearFeatured('ws-1');

      expect(mockDb.update).toHaveBeenCalledWith(insights);
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ is_featured: false, updated_at: expect.anything() }),
      );
      expect(mockDb.where).toHaveBeenCalledTimes(1);
    });
  });
});
