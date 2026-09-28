import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { InsightTemplateRepository } from './insightTemplateRepository';
import { insightTemplates, users } from '@/lib/db/schema';

const CHAIN = [
  'select',
  'from',
  'leftJoin',
  'where',
  'orderBy',
  'limit',
  'insert',
  'values',
  'update',
  'set',
  'delete',
] as const;
type MockDb = Record<(typeof CHAIN)[number] | 'returning', ReturnType<typeof vi.fn>>;

function createMockDb(): MockDb {
  const mock = { returning: vi.fn() } as MockDb;
  for (const k of CHAIN) mock[k] = vi.fn().mockReturnThis();
  return mock;
}

const dialect = new PgDialect();
const toQuery = (fragment: unknown) => dialect.sqlToQuery(fragment as SQL);

describe('InsightTemplateRepository', () => {
  let mockDb: MockDb;
  let repo: InsightTemplateRepository;
  const workspaceId = 'ws-test-123';
  const where = (db: MockDb = mockDb) => toQuery(db.where.mock.calls[0][0]);

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new InsightTemplateRepository(mockDb as never, workspaceId);
  });

  describe('InsightTemplateRepository.list', () => {
    it('returns live templates with the creator name in one query, newest first', async () => {
      const items = [{ id: 'tpl-1', created_by_name: 'Ada' }];
      mockDb.orderBy.mockResolvedValueOnce(items);

      expect(await repo.list()).toEqual(items);
      expect(mockDb.select).toHaveBeenCalledTimes(1);
      const columns = mockDb.select.mock.calls[0][0];
      expect(columns).not.toHaveProperty('html');
      expect(columns).toHaveProperty('name');
      expect(columns.created_by_name).toBe(users.name);
      expect(mockDb.from).toHaveBeenCalledWith(insightTemplates);
      expect(mockDb.leftJoin).toHaveBeenCalledWith(users, expect.anything());
      const q = where();
      expect(q.params).toEqual([workspaceId]);
      expect(q.sql).toContain('"deleted_at" is null');
      expect(toQuery(mockDb.orderBy.mock.calls[0][0]).sql).toContain('"created_at" desc');
    });
  });

  describe('InsightTemplateRepository.listDeleted', () => {
    it('returns only soft-deleted templates, most recently deleted first', async () => {
      mockDb.orderBy.mockResolvedValueOnce([]);

      await repo.listDeleted();

      const q = where();
      expect(q.params).toEqual([workspaceId]);
      expect(q.sql).toContain('"deleted_at" is not null');
      expect(toQuery(mockDb.orderBy.mock.calls[0][0]).sql).toContain('"deleted_at" desc');
    });
  });

  describe('InsightTemplateRepository.findById', () => {
    it('returns the full row, html included, and leaves out soft-deleted rows by default', async () => {
      const template = { id: 'tpl-1', name: 'Market Brief', html: '<h1>Brief</h1>' };
      mockDb.limit.mockResolvedValueOnce([template]);

      expect(await repo.findById('tpl-1')).toEqual(template);
      expect(mockDb.select).toHaveBeenCalledWith();
      const q = where();
      expect(q.params).toEqual(expect.arrayContaining([workspaceId, 'tpl-1']));
      expect(q.sql).toContain('"deleted_at" is null');
      expect(mockDb.limit).toHaveBeenCalledWith(1);
    });

    it('includes soft-deleted rows when asked to', async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await repo.findById('tpl-1', { includeDeleted: true });

      expect(where().sql).not.toContain('deleted_at');
    });

    it('reads through the given executor', async () => {
      const tx = createMockDb();
      tx.limit.mockResolvedValueOnce([]);

      await repo.findById('tpl-1', { executor: tx as never });

      expect(tx.select).toHaveBeenCalled();
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('returns null when not found', async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      expect(await repo.findById('non-existent')).toBeNull();
    });
  });

  describe('InsightTemplateRepository.findLiveRefById', () => {
    it('reads one live row by id and workspace, without the HTML', async () => {
      const ref = { id: 'tpl-1', workspace_id: workspaceId, name: 'Market Brief' };
      mockDb.limit.mockResolvedValueOnce([ref]);

      expect(await repo.findLiveRefById('tpl-1')).toEqual(ref);
      const columns = mockDb.select.mock.calls[0][0];
      expect(Object.keys(columns).sort()).toEqual(['id', 'name', 'workspace_id']);
      expect(mockDb.from).toHaveBeenCalledWith(insightTemplates);
      const q = where();
      expect(q.params).toEqual(expect.arrayContaining([workspaceId, 'tpl-1']));
      expect(q.sql).toContain('"deleted_at" is null');
      expect(mockDb.limit).toHaveBeenCalledWith(1);
    });

    it('returns null for a missing or soft-deleted template', async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      expect(await repo.findLiveRefById('tpl-gone')).toBeNull();
    });
  });

  describe('InsightTemplateRepository.insert', () => {
    it('sets workspace_id and returns the inserted row without html', async () => {
      const input = {
        name: 'Market Brief',
        description: 'Sector brief template',
        html: '<h1>Brief</h1>',
        created_by: 'user-1',
      };
      const created = { id: 'tpl-new', name: input.name, workspace_id: workspaceId };
      mockDb.returning.mockResolvedValueOnce([created]);

      expect(await repo.insert(input)).toEqual(created);
      expect(mockDb.insert).toHaveBeenCalledWith(insightTemplates);
      expect(mockDb.values).toHaveBeenCalledWith({ ...input, workspace_id: workspaceId });
      expect(mockDb.returning.mock.calls[0][0]).not.toHaveProperty('html');
    });

    it('writes through the given executor', async () => {
      const tx = createMockDb();
      tx.returning.mockResolvedValueOnce([{ id: 'tpl-new' }]);

      await repo.insert({ name: 'N', html: '<p>x</p>' }, tx as never);

      expect(tx.insert).toHaveBeenCalledWith(insightTemplates);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });
  });

  describe('InsightTemplateRepository.update', () => {
    it('writes the patch, html included, bumps updated_at and only matches a live row', async () => {
      const patch = { name: 'Updated Name', icon: 'scale', html: '<p>v2</p>' };
      const updated = { id: 'tpl-1', name: patch.name };
      mockDb.returning.mockResolvedValueOnce([updated]);

      expect(await repo.update('tpl-1', patch)).toEqual(updated);
      expect(mockDb.update).toHaveBeenCalledWith(insightTemplates);
      expect(mockDb.set).toHaveBeenCalledWith({ ...patch, updated_at: expect.anything() });
      const q = where();
      expect(q.params).toEqual(expect.arrayContaining([workspaceId, 'tpl-1']));
      expect(q.sql).toContain('"deleted_at" is null');
      expect(mockDb.returning.mock.calls[0][0]).not.toHaveProperty('html');
    });

    it('writes through the given executor', async () => {
      const tx = createMockDb();
      tx.returning.mockResolvedValueOnce([{ id: 'tpl-1' }]);

      await repo.update('tpl-1', { html: '<p>v2</p>' }, tx as never);

      expect(tx.update).toHaveBeenCalledWith(insightTemplates);
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('returns null when no live template matches', async () => {
      mockDb.returning.mockResolvedValueOnce([]);
      expect(await repo.update('non-existent', { name: 'New Name' })).toBeNull();
    });

    it('skips the UPDATE for an empty patch and returns the current row without html', async () => {
      const existing = { id: 'tpl-1', name: 'Existing Name' };
      mockDb.limit.mockResolvedValueOnce([existing]);

      expect(await repo.update('tpl-1', {})).toEqual(existing);
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(mockDb.select.mock.calls[0][0]).not.toHaveProperty('html');
      expect(mockDb.limit).toHaveBeenCalledWith(1);
    });
  });

  describe('InsightTemplateRepository.softDelete', () => {
    it('stamps deleted_at on a live row and returns it', async () => {
      const row = { id: 'tpl-1' };
      mockDb.returning.mockResolvedValueOnce([row]);

      expect(await repo.softDelete('tpl-1')).toEqual(row);
      expect(mockDb.update).toHaveBeenCalledWith(insightTemplates);
      expect(mockDb.set).toHaveBeenCalledWith({ deleted_at: expect.anything() });
      expect(mockDb.delete).not.toHaveBeenCalled();
      const q = where();
      expect(q.params).toEqual(expect.arrayContaining([workspaceId, 'tpl-1']));
      expect(q.sql).toContain('"deleted_at" is null');
    });

    it('returns null when the template is missing or already deleted', async () => {
      mockDb.returning.mockResolvedValueOnce([]);
      expect(await repo.softDelete('tpl-1')).toBeNull();
    });
  });

  describe('InsightTemplateRepository.restore', () => {
    it('clears deleted_at on a soft-deleted row only', async () => {
      const row = { id: 'tpl-1' };
      mockDb.returning.mockResolvedValueOnce([row]);

      expect(await repo.restore('tpl-1')).toEqual(row);
      expect(mockDb.set).toHaveBeenCalledWith({ deleted_at: null });
      const q = where();
      expect(q.params).toEqual(expect.arrayContaining([workspaceId, 'tpl-1']));
      expect(q.sql).toContain('"deleted_at" is not null');
    });

    it('returns null when no deleted template matches', async () => {
      mockDb.returning.mockResolvedValueOnce([]);
      expect(await repo.restore('tpl-1')).toBeNull();
    });
  });

  describe('InsightTemplateRepository.hardDelete', () => {
    it('deletes the row matching id and workspace, deleted or not, and returns it', async () => {
      const deleted = { id: 'tpl-1', name: 'To Delete' };
      mockDb.returning.mockResolvedValueOnce([deleted]);

      expect(await repo.hardDelete('tpl-1')).toEqual(deleted);
      expect(mockDb.delete).toHaveBeenCalledWith(insightTemplates);
      const q = where();
      expect(q.params).toEqual(expect.arrayContaining([workspaceId, 'tpl-1']));
      expect(q.sql).not.toContain('deleted_at');
    });

    it('returns null when no matching template exists', async () => {
      mockDb.returning.mockResolvedValueOnce([]);
      expect(await repo.hardDelete('non-existent')).toBeNull();
    });
  });
});
