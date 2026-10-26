import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { DealContactRepository } from './dealContactRepository';

type Chain = Record<string, ReturnType<typeof vi.fn>> & {
  then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise<unknown>;
};

/** Drizzle chain stub: every builder step returns the chain; awaiting it yields `result`. */
function makeDb(result: unknown[] = []) {
  const chain = {} as Chain;
  for (const m of [
    'select',
    'from',
    'innerJoin',
    'where',
    'orderBy',
    'limit',
    'insert',
    'values',
    'onConflictDoUpdate',
    'update',
    'set',
  ]) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.returning = vi.fn().mockResolvedValue(result);
  chain.execute = vi.fn().mockResolvedValue({ rows: [] });
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

const dialect = new PgDialect();
const toQuery = (s: unknown) => dialect.sqlToQuery(s as SQL);

describe('DealContactRepository', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: DealContactRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new DealContactRepository(db as never);
  });

  describe('empty id lists', () => {
    it('returns [] without hitting the DB', async () => {
      await expect(repo.listForContacts('w1', [])).resolves.toEqual([]);
      await expect(
        repo.insertEmailMentionLinks('w1', { correspondentIds: [], excludedDomains: [], limit: 10 }),
      ).resolves.toEqual([]);
      await expect(
        repo.insertFileSourceLinks('w1', { fileIds: [], excludedSenderDomains: [], limit: 10 }),
      ).resolves.toEqual([]);
      await expect(
        repo.insertFileSourceLinks('w1', { correspondentIds: [], excludedSenderDomains: [], limit: 10 }),
      ).resolves.toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
      expect(db.execute).not.toHaveBeenCalled();
    });
  });

  describe('listActiveForCompanies', () => {
    it('returns [] without hitting the DB for no companies', async () => {
      await expect(repo.listActiveForCompanies('w1', [])).resolves.toEqual([]);
      expect(db.select).not.toHaveBeenCalled();
    });

    it('reads active links of the companies in this workspace in one query', async () => {
      const rows = [{ companyId: 'c1', correspondentId: 'k1', role: 'source' }];
      db = makeDb(rows);
      repo = new DealContactRepository(db as never);

      await expect(repo.listActiveForCompanies('w1', ['c1', 'c2'])).resolves.toEqual(rows);
      expect(db.select).toHaveBeenCalledTimes(1);
      const { sql, params } = toQuery(db.where.mock.calls[0][0]);
      expect(sql).toContain('"deal_contacts"."status" = $');
      expect(params).toEqual(['w1', 'c1', 'c2', 'active']);
    });
  });

  describe('listForContacts', () => {
    it('filters links and the joined company by workspace and the contact ids, with every company created_at', async () => {
      await repo.listForContacts('w1', ['c1', 'c2']);

      const join = toQuery(db.innerJoin.mock.calls[0][1]);
      expect(join.sql).toContain('"companies"."workspace_id" = $');
      expect(join.params).toContain('w1');
      const where = toQuery(db.where.mock.calls[0][0]);
      expect(where.sql).toContain('"deal_contacts"."workspace_id" = $1');
      expect(where.sql).toContain('"deal_contacts"."correspondent_id" in ($2, $3)');
      expect(where.sql).not.toContain('created_at');
      expect(where.params).toEqual(['w1', 'c1', 'c2']);
      expect(Object.keys(db.select.mock.calls[0][0])).toContain('companyCreatedAt');
    });

    it('keeps only companies created at or after since', async () => {
      await repo.listForContacts('w1', ['c1'], { since: '2026-01-01T00:00:00.000Z' });

      const where = toQuery(db.where.mock.calls[0][0]);
      expect(where.sql).toContain('"companies"."created_at" >= $3');
      expect(where.params).toEqual(['w1', 'c1', '2026-01-01T00:00:00.000Z']);
    });
  });

  describe('hasActiveLinks', () => {
    it('looks for one active link in the workspace', async () => {
      db = makeDb([{ id: 'l1' }]);
      repo = new DealContactRepository(db as never);

      await expect(repo.hasActiveLinks('w1')).resolves.toBe(true);
      const where = toQuery(db.where.mock.calls[0][0]);
      expect(where.sql).toContain('"deal_contacts"."workspace_id" = $1');
      expect(where.sql).toContain('"deal_contacts"."status" = $2');
      expect(where.params).toEqual(['w1', 'active']);
      expect(db.limit).toHaveBeenCalledWith(1);
    });

    it('is false when the workspace has none', async () => {
      await expect(repo.hasActiveLinks('w1')).resolves.toBe(false);
    });
  });

  describe('upsertLink', () => {
    it('inserts and on the unique pair overwrites role, origin and status', async () => {
      db = makeDb([{ id: 'l1' }]);
      repo = new DealContactRepository(db as never);

      await repo.upsertLink({
        workspaceId: 'w1',
        companyId: 'co1',
        correspondentId: 'c1',
        role: 'source',
        origin: 'manual',
        status: 'active',
        createdBy: 'u1',
      });

      expect(db.values).toHaveBeenCalledWith(
        expect.objectContaining({
          workspace_id: 'w1',
          company_id: 'co1',
          correspondent_id: 'c1',
          role: 'source',
          origin: 'manual',
          status: 'active',
          evidence_message_id: null,
          created_by: 'u1',
        }),
      );
      const conflict = db.onConflictDoUpdate.mock.calls[0][0];
      expect(conflict.target.map((c: { name: string }) => c.name)).toEqual([
        'workspace_id',
        'company_id',
        'correspondent_id',
      ]);
      expect(conflict.set).toEqual(
        expect.objectContaining({ role: 'source', origin: 'manual', status: 'active' }),
      );
    });
  });

  describe('setStatus', () => {
    it('updates only the pair in the workspace and returns the row', async () => {
      db = makeDb([{ id: 'l1', status: 'dismissed' }]);
      repo = new DealContactRepository(db as never);

      await expect(repo.setStatus('w1', 'co1', 'c1', 'dismissed')).resolves.toEqual({
        id: 'l1',
        status: 'dismissed',
      });
      expect(db.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'dismissed' }));
      const where = toQuery(db.where.mock.calls[0][0]);
      expect(where.params).toEqual(['w1', 'co1', 'c1']);
    });

    it('returns undefined when there is no such link', async () => {
      await expect(repo.setStatus('w1', 'co1', 'c1', 'dismissed')).resolves.toBeUndefined();
    });
  });

  describe('insertEmailMentionLinks', () => {
    it('writes involved auto_email links set-based, skipping discovered companies and existing rows', async () => {
      db.execute.mockResolvedValueOnce({
        rows: [
          { company_id: 'co1', correspondent_id: 'c1' },
          { company_id: 'co2', correspondent_id: 'c2' },
        ],
      });

      const rows = await repo.insertEmailMentionLinks('w1', {
        excludedDomains: ['Ours.example'],
        limit: 50,
      });

      expect(rows).toEqual([
        { companyId: 'co1', correspondentId: 'c1' },
        { companyId: 'co2', correspondentId: 'c2' },
      ]);
      expect(db.execute).toHaveBeenCalledTimes(1);
      const { sql, params } = toQuery(db.execute.mock.calls[0][0]);
      expect(sql).toContain('INSERT INTO "public"."deal_contacts"');
      expect(sql).toContain("'involved', 'auto_email', 'active'");
      expect(sql).not.toContain("'source'");
      expect(sql).toMatch(/c\.pipeline_stage <> \$\d+/);
      expect(params).toContain('discovered');
      expect(sql).toContain('"analytics"."employer_related_company_evidence"');
      expect(sql).toContain('ep.user_id IS NULL');
      expect(sql).toContain('erc.dismissed_at IS NULL');
      expect(sql).toContain('erc.company_id IS NOT NULL');
      expect(sql).toContain('"public"."workspace_correspondents" wc');
      expect(sql).toContain('cu.email = em.custodian_email');
      expect(sql).toContain('lower(u.email) = lower(ep.address)');
      expect(sql).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM "public"\."deal_contacts" dc/);
      expect(sql).toContain('SELECT DISTINCT erc.company_id, ep.correspondent_id');
      expect(sql).toContain('ORDER BY erc.company_id, ep.correspondent_id');
      expect(sql).toContain('ON CONFLICT (workspace_id, company_id, correspondent_id) DO NOTHING');
      // Workspace-wide: no contact or since filter.
      expect(sql).not.toContain('ep.correspondent_id IN (');
      expect(sql).not.toContain('ev.created_at >=');
      // Domains compare lower-cased against the participant address.
      expect(sql).toContain("lower(substring(ep.address from '@([^@]*)$')) NOT IN (");
      expect(params).toContain('ours.example');
      expect(params).toContain('w1');
      expect(params).toContain(50);
    });

    it('narrows to the contacts and to evidence written since', async () => {
      await repo.insertEmailMentionLinks('w1', {
        correspondentIds: ['c1', 'c2'],
        since: '2026-10-25T00:00:00.000Z',
        excludedDomains: [],
        limit: 10,
      });

      const { sql, params } = toQuery(db.execute.mock.calls[0][0]);
      expect(sql).toMatch(/ep\.correspondent_id IN \(\$\d+, \$\d+\)/);
      expect(sql).toMatch(/ev\.created_at >= \$\d+::timestamptz/);
      expect(sql).not.toContain('NOT IN (');
      expect(params).toEqual(expect.arrayContaining(['c1', 'c2', '2026-10-25T00:00:00.000Z']));
    });
  });

  describe('insertFileSourceLinks', () => {
    it('writes links set-based, never touching existing rows', async () => {
      db.execute.mockResolvedValueOnce({
        rows: [
          { company_id: 'co1', correspondent_id: 'c1', role: 'source' },
          { company_id: 'co2', correspondent_id: 'c1', role: 'involved' },
        ],
      });

      const rows = await repo.insertFileSourceLinks('w1', {
        fileIds: ['f1'],
        excludedSenderDomains: ['Ours.example'],
        limit: 50,
      });

      expect(rows).toEqual([
        { companyId: 'co1', correspondentId: 'c1', role: 'source' },
        { companyId: 'co2', correspondentId: 'c1', role: 'involved' },
      ]);
      expect(db.execute).toHaveBeenCalledTimes(1);
      const { sql, params } = toQuery(db.execute.mock.calls[0][0]);
      expect(sql).toContain('INSERT INTO "public"."deal_contacts"');
      expect(sql).toContain('ON CONFLICT (workspace_id, company_id, correspondent_id) DO NOTHING');
      expect(sql).toContain("'auto_created_from_file:' || f.id::text");
      expect(sql).toContain('c.workspace_id = f.workspace_id');
      expect(sql).toContain('wc.workspace_id = f.workspace_id');
      expect(sql).toContain('f.id IN (');
      expect(params).toContain('w1');
      expect(params).toContain('f1');
      // Domains compare lower-cased.
      expect(params).toContain('ours.example');
      expect(params).toContain(50);
    });

    it('narrows by contact ids through the sender address', async () => {
      await repo.insertFileSourceLinks('w1', {
        correspondentIds: ['c1'],
        excludedSenderDomains: [],
        limit: 10,
      });

      const { sql, params } = toQuery(db.execute.mock.calls[0][0]);
      expect(sql).toContain('co.id IN (');
      expect(sql).toContain('lower(f.source_sender_email) IN (');
      expect(sql).not.toContain('f.id IN (');
      expect(sql).not.toContain('NOT IN');
      expect(params).toContain('c1');
    });
  });
});
