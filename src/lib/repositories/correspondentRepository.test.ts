import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { correspondents } from '@/lib/db/schema';
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
    it('marks the first row primary — the query sorts the workspace pick first, then the oldest', async () => {
      db.orderBy.mockResolvedValueOnce([
        { id: 'c1', employer_id: 'e1', created_at: '2026-01-01' },
        { id: 'c2', employer_id: 'e1', created_at: '2026-01-02' },
      ]);

      const result = await repo.findByEmployerId('e1', 'w1');

      expect(result[0]).toMatchObject({ id: 'c1', is_primary: true });
      expect(result[1]).toMatchObject({ id: 'c2', is_primary: false });
      const order = db.orderBy.mock.calls[0].map(
        (c: unknown) => new PgDialect().sqlToQuery(c as never).sql,
      );
      expect(order[0]).toContain('"is_primary" desc');
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
      const { sql: text, params } = new PgDialect().sqlToQuery(db.where.mock.calls[0][0]);
      expect(text).toContain('"correspondent_workspace_effective"."workspace_id"');
      expect(params).toContain('other-workspace');
    });

    it("returns the workspace view's row, so its profile edits and PIC pick come with it", async () => {
      db.limit.mockResolvedValueOnce([{ id: 'c1', employer_id: 'e1', is_primary: true }]);

      const result = await repo.findById('c1', 'w1');

      expect(result).toMatchObject({ id: 'c1', is_primary: true });
      expect(db.from).toHaveBeenCalledTimes(1);
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
      db.limit.mockResolvedValueOnce([{ id: 'c1', employer_id: 'e1', is_primary: false }]);

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
    /** The compiled WHERE of the search query (visibility is the view's own rows). */
    function searchWhere() {
      return new PgDialect().sqlToQuery(db.where.mock.calls[0]?.[0]);
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

      // Visibility is the workspace view's own rows: filter on its workspace.
      const { sql: text, params } = searchWhere();
      expect(text).toContain('"correspondent_workspace_effective"."workspace_id" =');
      expect(params).toContain('w1');
      expect(params).toContain('published');
      // The firm side is joined in the same workspace, so its curated name
      // is this workspace's.
      const join = new PgDialect().sqlToQuery(db.innerJoin.mock.calls[0][1]).sql;
      expect(join).toContain('"employer_workspace_effective"."workspace_id"');
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
      const { sql: text } = new PgDialect().sqlToQuery(db.where.mock.calls[0]?.[0]);
      expect(text).toContain('"topics"."workspace_id"');
      // Tags themselves are per workspace too.
      expect(text).toContain('"employer_topics"."workspace_id"');

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

  describe('workspace visibility (via findByEmployerId)', () => {
    it('scopes on workspace membership alone — no source or email-sync gate, so an ingest-derived contact stays visible after the last mailbox is un-synced', async () => {
      db.orderBy.mockResolvedValueOnce([]);
      await repo.findByEmployerId('e1', 'w1');

      // The view's rows ARE the workspace_correspondents memberships, so the
      // only visibility predicate is its workspace column.
      const { sql: text } = new PgDialect().sqlToQuery(db.where.mock.calls[0]?.[0]);
      expect(text).toContain('"correspondent_workspace_effective"."workspace_id"');
      expect(text).not.toContain("!= 'ingest'");
      expect(text).not.toContain('user_workspaces');
      expect(text).not.toContain('is_email_synced');
    });
  });
});

describe('CorrespondentRepository email join key', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: CorrespondentRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new CorrespondentRepository(db as never);
  });

  it('findByEmails returns [] without hitting the DB when no usable email is given', async () => {
    expect(await repo.findByEmails([])).toEqual([]);
    expect(await repo.findByEmails(['  '])).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('findByEmails matches lower(email) against deduped, lowercased input across employers', async () => {
    db.orderBy.mockResolvedValueOnce([{ id: 'c1', email: 'A@b.com' }]);
    const out = await repo.findByEmails(['A@B.com', ' a@b.com ']);
    expect(out).toEqual([{ id: 'c1', email: 'A@b.com' }]);
    const where = new PgDialect().sqlToQuery(db.where.mock.calls[0][0]);
    expect(where.sql).toMatch(/lower\("correspondent_effective"\."email"\) in \(\$1\)/i);
    expect(where.params).toEqual(['a@b.com']);
    // No employer filter: the join is on email alone.
    expect(where.sql).not.toMatch(/employer_id/);
  });

  it('findByEmployerAndEmail compares emails case-insensitively', async () => {
    db.limit.mockResolvedValueOnce([{ id: 'c1' }]);
    await repo.findByEmployerAndEmail('e1', 'A@B.com');
    const where = new PgDialect().sqlToQuery(db.where.mock.calls[0][0]);
    expect(where.params).toContain('a@b.com');
  });

  it('insertMany returns [] without hitting the DB for no rows', async () => {
    expect(await repo.insertMany([])).toEqual([]);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it('insertMany strips is_primary and skips (employer_id, email) conflicts', async () => {
    const onConflictDoNothing = vi.fn().mockReturnThis();
    Object.assign(db, { onConflictDoNothing });
    db.returning.mockResolvedValueOnce([{ id: 'c1', email: 'a@b.com' }]);
    const out = await repo.insertMany([
      { employer_id: 'e1', name: 'A', email: 'a@b.com', is_primary: true } as never,
    ]);
    expect(db.values).toHaveBeenCalledWith([
      { employer_id: 'e1', name: 'A', email: 'a@b.com' },
    ]);
    expect(onConflictDoNothing).toHaveBeenCalledWith({
      target: [correspondents.employer_id, correspondents.email],
      where: expect.anything(),
    });
    expect(out).toEqual([{ id: 'c1', email: 'a@b.com' }]);
  });

  it('upsertBatch never rewrites the profile of a manually-added contact', async () => {
    db.onConflictDoUpdate.mockReturnThis();
    db.returning.mockResolvedValueOnce([{ id: 'c1', email: 'a@b.com' }]);
    await repo.upsertBatch([{ employer_id: 'e1', name: 'A', email: 'a@b.com' }]);
    const { set } = db.onConflictDoUpdate.mock.calls[0][0];
    const dialect = new PgDialect();
    for (const col of ['name', 'title', 'phone', 'type', 'source']) {
      expect(dialect.sqlToQuery(set[col]).sql).toMatch(
        /CASE WHEN "correspondents"\."origin" = 'manual'/,
      );
    }
  });

  it('upsertBatch keeps a real stored name when the incoming name is address-like', async () => {
    db.onConflictDoUpdate.mockReturnThis();
    db.returning.mockResolvedValueOnce([{ id: 'c1', email: 'a@b.com' }]);
    await repo.upsertBatch([{ employer_id: 'e1', name: 'a@b.com', email: 'a@b.com' }]);
    const { set } = db.onConflictDoUpdate.mock.calls[0][0];
    const text = new PgDialect().sqlToQuery(set.name).sql;
    expect(text).toBe(
      `CASE WHEN "correspondents"."origin" = 'manual' THEN "correspondents"."name" ` +
        `WHEN (COALESCE(btrim(EXCLUDED.name), '') = '' OR strpos(EXCLUDED.name, '@') > 0 OR lower(btrim(EXCLUDED.name)) = lower(btrim(COALESCE(EXCLUDED.email, '')))) ` +
        `AND NOT (COALESCE(btrim("correspondents"."name"), '') = '' OR strpos("correspondents"."name", '@') > 0 OR lower(btrim("correspondents"."name")) = lower(btrim(COALESCE("correspondents"."email", '')))) ` +
        `THEN "correspondents"."name" ELSE EXCLUDED.name END`,
    );
  });
});

describe('CorrespondentRepository.searchInEmployers', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: CorrespondentRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new CorrespondentRepository(db as never);
  });

  it('returns [] without hitting the DB for no firms or a blank term', async () => {
    expect(await repo.searchInEmployers([], 'jane', 'w1')).toEqual([]);
    expect(await repo.searchInEmployers(['e1'], '   ', 'w1')).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('matches name or email across the page of firms in one query, workspace-scoped and ordered for grouping', async () => {
    db.limit.mockResolvedValueOnce([{ id: 'c1', employer_id: 'e1', name: 'Jane' }]);
    const out = await repo.searchInEmployers(['e1', 'e2'], ' Jane ', 'w1');
    expect(out).toEqual([{ id: 'c1', employer_id: 'e1', name: 'Jane' }]);
    const { sql: text, params } = new PgDialect().sqlToQuery(db.where.mock.calls[0][0]);
    expect(text).toMatch(/"employer_id" in \(\$1, \$2\)/);
    expect(text).toMatch(/"name" ilike/i);
    expect(text).toMatch(/"email" ilike/i);
    expect(params).toContain('%Jane%');
    expect(text).toMatch(/"correspondent_workspace_effective"\."workspace_id" =/i);
    expect(db.orderBy).toHaveBeenCalledTimes(1);
    expect(db.limit).toHaveBeenCalledWith(1000);
  });
});
