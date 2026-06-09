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
      const out = await repo.list();
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
      await repo.list({ lastContactBefore: '2026-05-01T00:00:00Z' });
      const whereArg = db.where.mock.calls[0]?.[0];
      const { sql: text } = new PgDialect().sqlToQuery(whereArg);
      expect(text).toContain('email_participants');
      expect(text).toContain('correspondents');
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
      const out = await repo.list();
      expect(out[0].response_p50_seconds).toBeNull();
      expect(out[0].response_pair_count).toBe(0);
    });
  });
});
