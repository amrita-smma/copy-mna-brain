import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { EmployerRepository } from './employerRepository';

function makeDb() {
  const db = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
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
      const out = await repo.findById('1');
      expect(out).toEqual({ id: '1', name: 'GS' });
    });

    it('returns undefined when missing', async () => {
      db.limit.mockResolvedValueOnce([]);
      expect(await repo.findById('x')).toBeUndefined();
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
      const out = await repo.findByIds([]);
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

    it('scopes primary_pic to correspondents visible to the workspace, ordered by created_at (positional primary)', async () => {
      db.offset.mockResolvedValueOnce([]);
      await repo.list({}, 'w1');
      const selectArg = db.select.mock.calls[0]?.[0];
      const { sql: text } = new PgDialect().sqlToQuery(selectArg.primary_pic);
      expect(text).toContain('workspace_correspondents');
      expect(text).not.toContain('workspace_primary_correspondents');
      expect(text).not.toContain('is_primary');
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
    expect(text).toMatch(/"correspondent_effective"\."name" ILIKE/);
    expect(text).toMatch(/"correspondent_effective"\."email" ILIKE/);
    expect(params).toContain('%jane%');
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
