import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { EmployerRepository } from './employerRepository';

function makeDb() {
  const db = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    returning: vi.fn(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  };
  return db;
}

describe('EmployerRepository', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: EmployerRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new EmployerRepository(db as never);
  });

  describe('findById', () => {
    it('returns the row when present', async () => {
      db.limit.mockResolvedValueOnce([{ id: '1', name: 'GS' }]);
      const out = await repo.findById('1', 'w1');
      expect(out).toEqual({ id: '1', name: 'GS' });
    });

    it('returns undefined when missing', async () => {
      db.limit.mockResolvedValueOnce([]);
      expect(await repo.findById('x', 'w1')).toBeUndefined();
    });

    it("reads this workspace's row of the per-workspace view, so its rename wins", async () => {
      db.limit.mockResolvedValueOnce([]);
      await repo.findById('1', 'w1');
      const { sql: text, params } = new PgDialect().sqlToQuery(db.where.mock.calls[0][0]);
      expect(text).toContain('"employer_workspace_effective"."workspace_id" =');
      expect(params).toEqual(['1', 'w1']);
    });
  });

  describe('insert', () => {
    it('inserts and returns the new row', async () => {
      db.returning.mockResolvedValueOnce([{ id: '1', name: 'GS' }]);
      const out = await repo.insert({
        name: 'GS',
        normalized_name: 'gs',
      });
      expect(db.insert).toHaveBeenCalled();
      expect(out).toEqual({ id: '1', name: 'GS' });
    });
  });

  describe('update', () => {
    it('stamps updated_at and returns the row', async () => {
      db.returning.mockResolvedValueOnce([{ id: '1', name: 'GS2' }]);
      const out = await repo.update('1', { name: 'GS2' });
      expect(db.set).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'GS2',
          updated_at: expect.any(String),
        }),
      );
      expect(out).toEqual({ id: '1', name: 'GS2' });
    });
  });

  describe('findByIds', () => {
    it('short-circuits to [] for an empty input', async () => {
      const out = await repo.findByIds([], 'w1');
      expect(out).toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });
  });

  describe('list', () => {
    it('returns the mapped summary rows', async () => {
      db.offset.mockResolvedValueOnce([
        {
          id: 'e1',
          name: 'GS',
          normalized_name: 'gs',
          industry: 'IB',
          status: 'inbound',
          curation_status: 'published',
          created_at: 't',
          updated_at: 't',
          email_count: 3,
          last_contact_at: '2026-05-01T00:00:00Z',
          response_p50_seconds: 259200,
          response_pair_count: 8,
          primary_pic: null,
          topics: [],
          team: [],
          source: 'manual',
        },
      ]);
      const out = await repo.list({}, 'w1');
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({
        id: 'e1',
        name: 'GS',
        email_count: 3,
        response_p50_seconds: 259200,
        response_pair_count: 8,
        source: 'manual',
      });
    });

    it('uses the participant-based join for lastContactBefore so the filter matches the displayed last_contact_at', async () => {
      db.offset.mockResolvedValueOnce([]);
      await repo.list({ lastContactBefore: '2026-05-01T00:00:00Z' }, 'w1');
      const whereArg = db.where.mock.calls[0]?.[0];
      const { sql: text } = new PgDialect().sqlToQuery(whereArg);
      expect(text).toContain('email_participants');
      expect(text).toContain('correspondents');
    });

    it('scopes the query to employers visible to the given workspace', async () => {
      db.offset.mockResolvedValueOnce([]);
      await repo.list({}, 'w1');
      const whereArg = db.where.mock.calls[0]?.[0];
      const { sql: text } = new PgDialect().sqlToQuery(whereArg);
      expect(text).toContain('workspace_correspondents');
      expect(text).toContain('employer_related_companies');
    });

    it('excludes dismissed related-company links from the visibility gate', async () => {
      db.offset.mockResolvedValueOnce([]);
      await repo.list({}, 'w1');
      const whereArg = db.where.mock.calls[0]?.[0];
      const { sql: text } = new PgDialect().sqlToQuery(whereArg);
      expect(text).toContain('dismissed_at');
    });

    it('also surfaces an employer via a workspace-owned note or private topic, not just correspondents/related-companies', async () => {
      db.offset.mockResolvedValueOnce([]);
      await repo.list({}, 'w1');
      const whereArg = db.where.mock.calls[0]?.[0];
      const { sql: text } = new PgDialect().sqlToQuery(whereArg);
      expect(text).toContain('employer_notes');
      expect(text).toContain('employer_topics');
    });

    it("picks primary_pic among the workspace's visible contacts: its chosen PIC first, else the oldest", async () => {
      db.offset.mockResolvedValueOnce([]);
      await repo.list({}, 'w1');
      const selectArg = db.select.mock.calls[0]?.[0];
      const { sql: text, params } = new PgDialect().sqlToQuery(selectArg.primary_pic);
      expect(text).toContain('"correspondent_workspace_effective"');
      expect(text).toContain('"cwe"."workspace_id" =');
      expect(params).toContain('w1');
      expect(text).toMatch(/ORDER BY "cwe"\."is_primary" DESC, "cwe"\."created_at" ASC/);
    });

    it("reads this workspace's tags, team and curated name only", async () => {
      db.offset.mockResolvedValueOnce([]);
      await repo.list({}, 'w1');
      const selectArg = db.select.mock.calls[0]?.[0];
      const dialect = new PgDialect();
      expect(dialect.sqlToQuery(selectArg.topics).sql).toContain('"employer_topics"."workspace_id" =');
      expect(dialect.sqlToQuery(selectArg.team).sql).toContain('"employer_team_members"."workspace_id" =');
      // The curated name comes from employer_curation LEFT JOINed on this
      // workspace's row.
      expect(dialect.sqlToQuery(selectArg.name).sql).toContain('"employer_curation"."name"');
      const curationJoin = db.leftJoin.mock.calls.find(([table]) => table !== undefined && !(table instanceof SQL));
      const on = dialect.sqlToQuery(curationJoin![1]);
      expect(on.sql).toContain('"employer_curation"."workspace_id" =');
      expect(on.params).toContain('w1');
    });

    it('reads the KPI mart through one workspace-scoped LEFT JOIN, not a correlated subquery per column', async () => {
      db.offset.mockResolvedValueOnce([]);
      await repo.list({}, 'w1');
      const dialect = new PgDialect();
      const martJoin = db.leftJoin.mock.calls.find(
        ([table]) => table instanceof SQL && dialect.sqlToQuery(table).sql.includes('mart_crm'),
      );
      expect(martJoin).toBeDefined();
      const on = dialect.sqlToQuery(martJoin![1]);
      expect(on.sql).toContain('"mart_crm"."workspace_id"');
      expect(on.params).toContain('w1');

      const selectArg = db.select.mock.calls[0]?.[0];
      expect(dialect.sqlToQuery(selectArg.email_count).sql).not.toContain('SELECT');
      expect(dialect.sqlToQuery(db.orderBy.mock.calls[0]?.[0]).sql).not.toContain('SELECT');
    });

    it('gates workspace visibility with one uncorrelated id set rather than per-row EXISTS probes', async () => {
      db.offset.mockResolvedValueOnce([]);
      await repo.list({}, 'w1');
      const { sql: text } = new PgDialect().sqlToQuery(db.where.mock.calls[0]?.[0]);
      expect(text).toContain('"employers"."id" IN (');
      expect(text).toContain('UNION');
      expect(text).not.toContain('EXISTS');
    });

    it('scopes the auto/manual source badge to correspondents visible to the workspace', async () => {
      db.offset.mockResolvedValueOnce([]);
      await repo.list({}, 'w1');
      const selectArg = db.select.mock.calls[0]?.[0];
      const { sql: text } = new PgDialect().sqlToQuery(selectArg.source);
      expect(text).toContain('workspace_correspondents');
    });

    it('does not gate primary_pic on the workspace having an email-synced member', async () => {
      db.offset.mockResolvedValueOnce([]);
      await repo.list({}, 'w1');
      const selectArg = db.select.mock.calls[0]?.[0];
      const { sql: text } = new PgDialect().sqlToQuery(selectArg.primary_pic);
      expect(text).not.toContain('user_workspaces');
      expect(text).not.toContain('is_email_synced');
    });

    it('does not gate the correspondent/related-company visibility branches on email sync, so an unsynced workspace still sees its ingested CRM data', async () => {
      db.offset.mockResolvedValueOnce([]);
      await repo.list({}, 'w1');
      const whereArg = db.where.mock.calls[0]?.[0];
      const { sql: text } = new PgDialect().sqlToQuery(whereArg);
      expect(text).not.toContain("!= 'ingest'");
      expect(text).not.toContain("!= 'auto'");
      expect(text).not.toContain('user_workspaces');
      expect(text).not.toContain('is_email_synced');
    });

    it('coerces numeric response fields from strings and keeps a null p50', async () => {
      db.offset.mockResolvedValueOnce([
        {
          id: 'e2',
          name: 'MS',
          normalized_name: 'ms',
          industry: null,
          status: 'inbound',
          curation_status: 'published',
          created_at: 't',
          updated_at: 't',
          email_count: 1,
          last_contact_at: null,
          // percentile_cont returns null when there are no pairs; COUNT comes
          // back as a string over the postgres wire.
          response_p50_seconds: null,
          response_pair_count: '0',
          primary_pic: null,
          topics: [],
          team: [],
          source: 'auto',
        },
      ]);
      const out = await repo.list({}, 'w1');
      expect(out[0].response_p50_seconds).toBeNull();
      expect(out[0].response_pair_count).toBe(0);
    });
  });

  describe('countFlagged', () => {
    it('counts flagged employers the workspace can see without an email-sync gate', async () => {
      db.where.mockResolvedValueOnce([{ n: '4' }]);

      const out = await repo.countFlagged('w1');

      expect(out).toBe(4);
      const { sql: text } = new PgDialect().sqlToQuery(db.where.mock.calls[0]?.[0]);
      expect(text).toContain('workspace_correspondents');
      expect(text).not.toContain("!= 'ingest'");
      expect(text).not.toContain('user_workspaces');
      expect(text).not.toContain('is_email_synced');
    });

    it('returns 0 when the count row is missing', async () => {
      db.where.mockResolvedValueOnce([]);
      expect(await repo.countFlagged('w1')).toBe(0);
    });
  });
});

describe('EmployerRepository.findByNormalizedNames', () => {
  it('returns [] without hitting the DB when the name list is empty', async () => {
    const db = makeDb();
    const repo = new EmployerRepository(db as never);
    expect(await repo.findByNormalizedNames([])).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('looks up every name in one query ordered by normalized name', async () => {
    const db = makeDb();
    db.orderBy.mockResolvedValueOnce([{ id: 'e1', normalized_name: 'gs' }]);
    const repo = new EmployerRepository(db as never);
    expect(await repo.findByNormalizedNames(['gs', 'ms'])).toEqual([
      { id: 'e1', normalized_name: 'gs' },
    ]);
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});

describe('EmployerRepository.list (search)', () => {
  it('matches people by their curated name or email, only among contacts the workspace can see', async () => {
    const db = makeDb();
    db.offset.mockResolvedValueOnce([]);
    const repo = new EmployerRepository(db as never);
    await repo.list({ search: 'jane' }, 'w1');
    const { sql: text, params } = new PgDialect().sqlToQuery(db.where.mock.calls[0]?.[0]);
    expect(text).toMatch(/"correspondent_workspace_effective"\."name" ILIKE/);
    expect(text).toMatch(/"correspondent_workspace_effective"\."email" ILIKE/);
    expect(text).toMatch(/"correspondent_workspace_effective"\."workspace_id" =/);
    expect(params).toContain('%jane%');
  });

  it('finds person candidates through the indexed base columns, then re-checks the workspace view', async () => {
    const db = makeDb();
    db.offset.mockResolvedValueOnce([]);
    await new EmployerRepository(db as never).list({ search: 'jane' }, 'w1');
    const { sql: text } = new PgDialect().sqlToQuery(db.where.mock.calls[0]?.[0]);
    expect(text).toContain('"correspondents"."name" ILIKE');
    expect(text).toContain('"correspondents"."email" ILIKE');
    expect(text).toMatch(/"correspondent_curation"\."workspace_id" =[\s\S]*"correspondent_curation"\."name" ILIKE/);
    expect(text).toMatch(/"employer_curation"\."workspace_id" =[\s\S]*"employer_curation"\."name" ILIKE/);
    expect(text).toContain('"employer_domains"."domain" ILIKE');
    expect(text).not.toContain('EXISTS');
  });

  it('applies no search predicate without a term', async () => {
    const db = makeDb();
    db.offset.mockResolvedValueOnce([]);
    await new EmployerRepository(db as never).list({}, 'w1');
    const { sql: text } = new PgDialect().sqlToQuery(db.where.mock.calls[0]?.[0]);
    expect(text).not.toContain('ILIKE');
  });

  it('escapes LIKE wildcards in the search term', async () => {
    const db = makeDb();
    db.offset.mockResolvedValueOnce([]);
    const repo = new EmployerRepository(db as never);
    await repo.list({ search: '50%_off' }, 'w1');
    const { params } = new PgDialect().sqlToQuery(db.where.mock.calls[0]?.[0]);
    expect(params).toContain('%50\\%\\_off%');
  });
});

describe('EmployerRepository.list (sort)', () => {
  async function leadingOrder(filters: Parameters<EmployerRepository['list']>[0]) {
    const db = makeDb();
    db.offset.mockResolvedValueOnce([]);
    await new EmployerRepository(db as never).list(filters, 'w1');
    const args = db.orderBy.mock.calls[0];
    return { leading: new PgDialect().sqlToQuery(args[0]), count: args.length };
  }

  it('defaults to latest last contact first, never-contacted firms last', async () => {
    const { leading } = await leadingOrder({});
    expect(leading.sql).toMatch(/"mart_crm"\."last_contact_at" DESC NULLS LAST$/);
  });

  it('keeps never-contacted firms last when sorting ascending', async () => {
    const { leading } = await leadingOrder({ sort: 'last_contact', sortDir: 'asc' });
    expect(leading.sql).toMatch(/ ASC NULLS LAST$/);
  });

  it.each([
    ['name', /"employer_curation"\."name"/],
    ['industry', /"employer_curation"\."industry"/],
    ['primary_pic', /LOWER\("cwe"\."name"\)/],
    ['response_p50', /"mart_crm"\."response_p50_seconds"/],
    ['emails', /"mart_crm"\."email_count"/],
    ['team_members', /COUNT\(\*\)[\s\S]*"employer_team_members"/],
  ] as const)('orders %s by its own column', async (sort, pattern) => {
    const { leading } = await leadingOrder({ sort, sortDir: 'asc' });
    expect(leading.sql).toMatch(pattern);
    expect(leading.sql).toMatch(/ ASC NULLS LAST$/);
  });

  it('breaks ties by name then id so pages never reshuffle', async () => {
    const { count } = await leadingOrder({ sort: 'emails' });
    expect(count).toBe(3);
  });

  it('never puts an unknown sort or direction into the SQL text', async () => {
    const { leading } = await leadingOrder({
      sort: 'name; DROP TABLE users; --' as never,
      sortDir: 'sideways' as never,
    });
    expect(leading.sql).not.toContain('DROP');
    expect(leading.sql).toMatch(/"mart_crm"\."last_contact_at" DESC NULLS LAST$/);
  });

  describe('claimForIndustryClassification', () => {
    it('claims in one statement scoped to the workspace and skips locked rows', async () => {
      const execute = vi.fn().mockResolvedValue({ rows: [{ id: 'e1' }, { id: 'e2' }] });
      const r = new EmployerRepository({ execute } as never);

      await expect(r.claimForIndustryClassification('w1', '2026-10-12T00:00:00.000Z', 60)).resolves.toEqual([
        'e1',
        'e2',
      ]);

      const { sql: text, params } = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
      expect(text).toContain('SET industry_classified_at = now()');
      expect(text).toContain('e.industry IS NULL');
      expect(text).toContain('c.industry IS NOT NULL');
      expect(text).toContain('FOR UPDATE SKIP LOCKED');
      expect(params).toEqual(['2026-10-12T00:00:00.000Z', 'w1', 'w1', 60]);
    });

    it('returns [] without hitting the DB when the limit or workspace is empty', async () => {
      const execute = vi.fn();
      const r = new EmployerRepository({ execute } as never);
      expect(await r.claimForIndustryClassification('w1', 'x', 0)).toEqual([]);
      expect(await r.claimForIndustryClassification('', 'x', 10)).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe('findIndustryEvidence', () => {
    it('returns [] without hitting the DB when the id list or workspace is empty', async () => {
      const execute = vi.fn();
      const r = new EmployerRepository({ execute, select: vi.fn() } as never);
      expect(await r.findIndustryEvidence('w1', [])).toEqual([]);
      expect(await r.findIndustryEvidence('', ['a'])).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    });

    it('groups domains and contacts under each firm from three batched reads', async () => {
      const firmsQuery = { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn() };
      const domainsQuery = { from: vi.fn().mockReturnThis(), where: vi.fn().mockReturnThis(), orderBy: vi.fn() };
      firmsQuery.orderBy.mockResolvedValue([
        { id: 'a', name: 'Alpha' },
        { id: 'b', name: 'Beta' },
      ]);
      domainsQuery.orderBy.mockResolvedValue([
        { employerId: 'a', domain: 'alpha.com' },
        { employerId: 'a', domain: 'alpha.sg' },
      ]);
      const select = vi.fn().mockReturnValueOnce(firmsQuery).mockReturnValueOnce(domainsQuery);
      const execute = vi.fn().mockResolvedValue({
        rows: [{ employer_id: 'b', title: 'Partner', specialization: null, bio: 'A law firm.' }],
      });
      const r = new EmployerRepository({ select, execute } as never);

      const out = await r.findIndustryEvidence('w1', ['a', 'b', 'a'], 4);

      expect(out).toEqual([
        { id: 'a', name: 'Alpha', domains: ['alpha.com', 'alpha.sg'], contacts: [] },
        {
          id: 'b',
          name: 'Beta',
          domains: [],
          contacts: [{ title: 'Partner', specialization: null, bio: 'A law firm.' }],
        },
      ]);
      expect(select).toHaveBeenCalledTimes(2);
      const { sql: text, params } = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
      expect(text).toContain('row_number() OVER');
      expect(text).toContain('"correspondent_workspace_effective" co');
      expect(params).toEqual(['w1', 'a', 'b', 4]);
    });
  });

  describe('releaseIndustryClaims', () => {
    it('does nothing for an empty list', async () => {
      const db = makeDb();
      await new EmployerRepository(db as never).releaseIndustryClaims([]);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('clears the claim stamp of still-unlabelled firms in one UPDATE', async () => {
      const db = makeDb();
      db.where.mockResolvedValueOnce(undefined);
      await new EmployerRepository(db as never).releaseIndustryClaims(['a', 'b']);
      expect(db.set).toHaveBeenCalledWith({ industry_classified_at: null });
      const { sql: text, params } = new PgDialect().sqlToQuery(db.where.mock.calls[0][0]);
      expect(text).toContain('"employers"."industry" IS NULL');
      expect(params).toEqual(['a', 'b']);
    });
  });

  describe('fillIndustries', () => {
    it('returns [] without hitting the DB when there is nothing to write', async () => {
      const execute = vi.fn();
      const r = new EmployerRepository({ execute } as never);
      expect(await r.fillIndustries([])).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    });

    it('writes every label in one UPDATE that only fills a NULL industry', async () => {
      const execute = vi.fn().mockResolvedValue({ rows: [{ id: 'a' }] });
      const r = new EmployerRepository({ execute } as never);

      await expect(
        r.fillIndustries([
          { id: 'a', industry: 'Legal' },
          { id: 'b', industry: 'Insurance' },
        ]),
      ).resolves.toEqual(['a']);

      expect(execute).toHaveBeenCalledTimes(1);
      const { sql: text, params } = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
      expect(text).toContain('e.industry IS NULL');
      expect(params).toEqual(['a', 'Legal', 'b', 'Insurance']);
    });
  });
});
