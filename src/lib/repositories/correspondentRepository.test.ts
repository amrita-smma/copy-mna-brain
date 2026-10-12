import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { CorrespondentRepository } from './correspondentRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
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

  describe('search', () => {
    /** The compiled WHERE of the main search query (call [1]; [0] is the visibility subquery). */
    function searchWhere() {
      return new PgDialect().sqlToQuery(db.where.mock.calls[1]?.[0]);
    }

    it('returns [] without querying when no facet has a usable term', async () => {
      const result = await repo.search(
        { departments: [], regions: ['  '], keyword: '' },
        'w1',
      );

      expect(result).toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('matches term facets on a word boundary so "US" cannot hit "Russia"', async () => {
      db.limit.mockResolvedValueOnce([]);
      await repo.search({ regions: ['US', 'North America'] }, 'w1');

      const { sql: text, params } = searchWhere();
      expect(text).toContain('~*');
      expect(params).toContain('(\\yUS\\y|\\yNorth America\\y)');
    });

    it('anchors only the sides of a term that end in a word character', async () => {
      db.limit.mockResolvedValueOnce([]);
      await repo.search({ regions: ['U.S.'] }, 'w1');

      // A trailing \y after "." would never match, so it is left off.
      expect(searchWhere().params).toContain('(\\yU\\.S\\.)');
    });

    it('matches name/firm facets by substring so a partial name still finds its owner', async () => {
      db.limit.mockResolvedValueOnce([]);
      await repo.search({ banker: 'jan' }, 'w1');

      const { sql: text, params } = searchWhere();
      expect(text).toContain('ILIKE');
      expect(params).toContain('%jan%');
    });

    it('scopes to the workspace and to published firms', async () => {
      db.limit.mockResolvedValueOnce([]);
      await repo.search({ departments: ['M&A'] }, 'w1');

      // Visibility is the same membership subquery every other read uses.
      const visibility = new PgDialect().sqlToQuery(db.where.mock.calls[0]?.[0]);
      expect(visibility.sql).toContain('workspace_correspondents');

      const { sql: text, params } = searchWhere();
      expect(text).toContain('"correspondent_effective"."id" in');
      expect(params).toContain('published');
    });

    it('returns a row when it matches any one facet, not all of them (scored OR)', async () => {
      db.limit.mockResolvedValueOnce([]);
      await repo.search({ departments: ['M&A'], regions: ['North America'] }, 'w1');

      // Facet predicates are OR-ed, never AND-ed: a LevFin banker in the wrong
      // region must still come back, ranked lower.
      const { sql: text } = searchWhere();
      const facetClause = text.slice(text.lastIndexOf(' and ('));
      expect(facetClause).toContain('"department" ~*');
      expect(facetClause).toContain(' or ');
      expect(facetClause).toContain('"coverage_region" ~*');
      // ...and nothing further ANDs the two facets together.
      expect(facetClause.split(' or ')[1]).not.toContain(' and ');
    });

    it('coerces the numeric columns pg returns as strings and defaults matched to []', async () => {
      db.limit.mockResolvedValueOnce([
        {
          id: 'c1',
          name: 'Jane',
          employer_id: 'e1',
          employer_name: 'GS',
          match_score: '7',
          email_count: '24',
          matched: null,
        },
      ]);

      const [row] = await repo.search({ departments: ['M&A'] }, 'w1');

      expect(row.match_score).toBe(7);
      expect(row.email_count).toBe(24);
      expect(row.matched).toEqual([]);
    });

    it('matches a user-typed LIKE wildcard literally instead of matching everyone', async () => {
      db.limit.mockResolvedValueOnce([]);
      await repo.search({ banker: '%' }, 'w1');

      // Unescaped, this compiles to ILIKE '%%%' — every row in the workspace.
      expect(searchWhere().params).toContain('%\\%%');
    });

    it('escapes the single-character LIKE wildcard too', async () => {
      db.limit.mockResolvedValueOnce([]);
      await repo.search({ firm: 'a_b' }, 'w1');

      expect(searchWhere().params).toContain('%a\\_b%');
    });

    it('scopes the KPI and topic subqueries to this workspace', async () => {
      db.limit.mockResolvedValueOnce([]);
      await repo.search({ topics: ['LBO financing'] }, 'w1');

      // A shared employer's numbers would otherwise sum across workspaces, and
      // another workspace's private topics would leak into the match.
      const { sql: text } = new PgDialect().sqlToQuery(db.where.mock.calls[1]?.[0]);
      expect(text).toContain('"topics"."workspace_id"');

      const selected = db.select.mock.calls[0]?.[0] ?? {};
      const marts = new PgDialect().sqlToQuery(selected.last_contact_at).sql;
      expect(marts).toContain('"mart_crm"."workspace_id"');
      expect(marts).toContain('"mart_crm"."employer_id"');
    });

    it('caps the limit at 50', async () => {
      db.limit.mockResolvedValueOnce([]);
      await repo.search({ departments: ['M&A'], limit: 500 }, 'w1');
      expect(db.limit).toHaveBeenCalledWith(50);
    });
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
