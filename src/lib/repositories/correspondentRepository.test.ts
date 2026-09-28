import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { CorrespondentRepository } from './correspondentRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  };
}

describe('CorrespondentRepository', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: CorrespondentRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new CorrespondentRepository(db as never);
  });

  describe('insert', () => {
    it('strips is_primary from the insert payload (primary is positional, not stored)', async () => {
      db.returning.mockResolvedValueOnce([{ id: 'c1', employer_id: 'e1', name: 'X' }]);

      const result = await repo.insert(
        { employer_id: 'e1', name: 'X', is_primary: true } as never,
        'w1',
      );

      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(db.values).toHaveBeenCalledWith({ employer_id: 'e1', name: 'X' });
      expect(result.is_primary).toBe(false);
    });
  });

  describe('findByEmployerId', () => {
    it('marks the oldest (first created_at) correspondent as primary — positional, no user designation', async () => {
      db.orderBy.mockResolvedValueOnce([
        { id: 'c1', employer_id: 'e1', created_at: '2026-01-01' },
        { id: 'c2', employer_id: 'e1', created_at: '2026-01-02' },
      ]);

      const result = await repo.findByEmployerId('e1', 'w1');

      expect(result[0]).toMatchObject({ id: 'c1', is_primary: true });
      expect(result[1]).toMatchObject({ id: 'c2', is_primary: false });
    });

    it('returns [] when no visible correspondents exist for the workspace', async () => {
      db.orderBy.mockResolvedValueOnce([]);
      const result = await repo.findByEmployerId('e1', 'w1');
      expect(result).toEqual([]);
    });
  });

  describe('findById', () => {
    it('scopes the by-id lookup to the workspace (prevents cross-workspace lookup by id)', async () => {
      db.limit.mockResolvedValueOnce([]);
      const result = await repo.findById('c1', 'other-workspace');

      expect(result).toBeUndefined();
      expect(db.where).toHaveBeenCalledTimes(2);
    });

    it('always returns is_primary: false (positional primary only applies to the full list)', async () => {
      db.limit.mockResolvedValueOnce([{ id: 'c1', employer_id: 'e1', is_primary: true }]);

      const result = await repo.findById('c1', 'w1');

      expect(result).toMatchObject({ id: 'c1', is_primary: false });
    });
  });

  describe('update', () => {
    it('is guarded to the workspace (cannot mutate another workspace\'s contact by id)', async () => {
      db.returning.mockResolvedValueOnce([]); // not visible to other-workspace
      const result = await repo.update('c1', { email: 'new@test.com' }, 'other-workspace');

      expect(result).toBeUndefined();
    });

    it('updates the base row and strips any is_primary field', async () => {
      db.returning.mockResolvedValueOnce([{ id: 'c1', employer_id: 'e1', name: 'New Name' }]);

      const result = await repo.update(
        'c1',
        { name: 'New Name', is_primary: true } as never,
        'w1',
      );

      expect(db.update).toHaveBeenCalledTimes(1);
      expect(db.set).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'New Name' }),
      );
      expect(db.set).not.toHaveBeenCalledWith(
        expect.objectContaining({ is_primary: expect.anything() }),
      );
      expect(result).toMatchObject({ id: 'c1', is_primary: false });
    });

    it('returns current row via findById when only is_primary is passed (no base-row update needed)', async () => {
      db.limit.mockResolvedValueOnce([{ id: 'c1', employer_id: 'e1' }]);

      const result = await repo.update('c1', { is_primary: true } as never, 'w1');

      expect(db.update).not.toHaveBeenCalled();
      expect(result).toMatchObject({ id: 'c1', is_primary: false });
    });
  });

  it('delete is guarded to the workspace', async () => {
    db.where.mockResolvedValueOnce(undefined);
    await repo.delete('c1', 'w1');
    expect(db.delete).toHaveBeenCalled();
    expect(db.where).toHaveBeenCalledTimes(2);
  });

  it('returns [] for findByIds with empty input', async () => {
    const out = await repo.findByIds([]);
    expect(out).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('looks up by (employer_id, email) for dedupe', async () => {
    db.limit.mockResolvedValueOnce([{ id: 'c1', email: 'a@b.com' }]);
    const out = await repo.findByEmployerAndEmail('e1', 'a@b.com');
    expect(out).toEqual({ id: 'c1', email: 'a@b.com' });
  });

  describe('visibleCorrespondentIds (via findByEmployerId)', () => {
    it('scopes on workspace membership alone — no source or email-sync gate, so an ingest-derived contact stays visible after the last mailbox is un-synced', async () => {
      db.orderBy.mockResolvedValueOnce([]); // main query result
      await repo.findByEmployerId('e1', 'w1');

      // db.where call order: [0] visibleCorrespondentIds subquery,
      // [1] the outer findByEmployerId where().
      const subqueryWhereArg = db.where.mock.calls[0]?.[0];
      const { sql: text } = new PgDialect().sqlToQuery(subqueryWhereArg);
      expect(text).toContain('workspace_correspondents');
      expect(text).not.toContain("!= 'ingest'");
      expect(text).not.toContain('user_workspaces');
      expect(text).not.toContain('is_email_synced');
    });
  });
});
