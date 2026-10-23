import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { ContactConversationRepository } from './contactConversationRepository';

function makeDb() {
  const select = vi.fn();
  const insertQuery: Record<string, ReturnType<typeof vi.fn>> = {};
  insertQuery.values = vi.fn().mockReturnValue(insertQuery);
  insertQuery.onConflictDoUpdate = vi.fn().mockReturnValue(insertQuery);
  insertQuery.returning = vi.fn().mockResolvedValue([]);

  const updateQuery: Record<string, ReturnType<typeof vi.fn>> = {};
  updateQuery.set = vi.fn().mockReturnValue(updateQuery);
  updateQuery.where = vi.fn().mockResolvedValue([]);

  const execute = vi.fn().mockResolvedValue({ rows: [] });

  const insert = vi.fn().mockReturnValue(insertQuery);
  const update = vi.fn().mockReturnValue(updateQuery);

  return {
    select,
    insert,
    insertQuery,
    update,
    updateQuery,
    execute,
  };
}

const dialect = new PgDialect();
const whereSql = (chain: { where: ReturnType<typeof vi.fn> }) =>
  dialect.sqlToQuery(chain.where.mock.calls[0][0] as SQL);

function makeQueryChain(rows: unknown[] = []) {
  const chain: any = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    leftJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    orderBy: vi.fn(() => chain),
    limit: vi.fn(async () => rows),
    then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

describe('ContactConversationRepository', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: ContactConversationRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new ContactConversationRepository(db as never);
  });

  describe('empty-id guards', () => {
    it('returns empty notes without hitting DB when workspaceId or correspondentId is empty', async () => {
      const res1 = await repo.listNotes('', 'c1', 'u1');
      expect(res1).toEqual({ notes: [], nextCursor: null });
      const res2 = await repo.listNotes('w1', '', 'u1');
      expect(res2).toEqual({ notes: [], nextCursor: null });
      expect(db.select).not.toHaveBeenCalled();

      const rollup = await repo.getRoleRollup('', 'c1', 'u1');
      expect(rollup).toEqual({ roles: [], emailCount: 0, evidence: null });
      expect(db.execute).not.toHaveBeenCalled();

      const hash = await repo.getNoteInputHash('w1', '');
      expect(hash).toEqual({ noteCount: 0, latestEmailId: null, dealCompanyIds: [] });
      expect(db.execute).not.toHaveBeenCalled();

      expect(await repo.listOverviewRefreshCandidates('', '2026-10-21T00:00:00Z')).toEqual([]);
      expect(await repo.listDealEvidenceEmails('w1', 'c1', [])).toEqual([]);
      expect(await repo.claimOverviewPending('w1', '')).toBe(false);
      expect(await repo.claimOverviewsPending('w1', [])).toEqual([]);
      await repo.setOverviewJobId('w1', [], 'job-1');
      expect(db.execute).not.toHaveBeenCalled();
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();

      expect(await repo.listNotesForSystem('', 'c1')).toEqual({ notes: [], nextCursor: null });

      const overview = await repo.getOverview('w1', '');
      expect(overview).toBeNull();
    });
  });

  describe('listNotes', () => {
    it('fetches team members in ONE batched call for the page and puts sender first', async () => {
      const notesChain = makeQueryChain([
        {
          emailId: 'e1',
          sentAt: '2026-10-10T10:00:00Z',
          direction: 'outbound',
          summary: 'Note 1',
          keyPoints: [],
          nextStep: null,
          nextStepStatus: 'none',
          sentiment: 'neutral',
        },
        {
          emailId: 'e2',
          sentAt: '2026-10-09T10:00:00Z',
          direction: 'inbound',
          summary: 'Note 2',
          keyPoints: [],
          nextStep: null,
          nextStepStatus: 'none',
          sentiment: 'neutral',
        },
      ]);

      const membersChain = makeQueryChain([
        { emailId: 'e1', userId: 'u1', name: 'Alice Sender', role: 'from' },
        { emailId: 'e1', userId: 'u2', name: 'Bob Recipient', role: 'to' },
        { emailId: 'e2', userId: 'u3', name: 'Charlie', role: 'to' },
      ]);

      db.select.mockReturnValueOnce(notesChain).mockReturnValueOnce(membersChain);

      const result = await repo.listNotes('w1', 'c1', 'u1', { limit: 20 });

      expect(db.select).toHaveBeenCalledTimes(2);
      expect(result.notes.length).toBe(2);

      // Note 1 team members: Alice was 'from' so Alice comes first
      const e1Members = result.notes[0].teamMembers;
      expect(e1Members.length).toBe(2);
      expect(e1Members[0].name).toBe('Alice Sender');
      expect(e1Members[1].name).toBe('Bob Recipient');
      expect(result.notes[1].teamMembers.length).toBe(1);
      expect(result.notes[1].teamMembers[0].name).toBe('Charlie');
    });

    it('pages with an opaque keyset cursor and ignores one it cannot read', async () => {
      const notesChain = makeQueryChain([
        {
          emailId: 'e1',
          sentAt: '2026-10-10T10:00:00Z',
          direction: 'inbound',
          summary: 'Note 1',
          keyPoints: [],
          nextStep: null,
          nextStepStatus: 'none',
          sentiment: 'neutral',
        },
        {
          emailId: 'e2',
          sentAt: '2026-10-09T10:00:00Z',
          direction: 'inbound',
          summary: 'Note 2',
          keyPoints: [],
          nextStep: null,
          nextStepStatus: 'none',
          sentiment: 'neutral',
        },
      ]);
      const membersChain = makeQueryChain([]);
      db.select.mockReturnValueOnce(notesChain).mockReturnValueOnce(membersChain);

      const result = await repo.listNotes('w1', 'c1', 'u1', { limit: 1 });
      expect(result.notes.map((n) => n.emailId)).toEqual(['e1']);
      expect(result.nextCursor).not.toBeNull();

      // The cursor resumes after the last note of the page.
      const nextChain = makeQueryChain([]);
      db.select.mockReturnValueOnce(nextChain);
      await repo.listNotes('w1', 'c1', 'u1', { cursor: result.nextCursor!, limit: 1 });
      const q = whereSql(nextChain);
      expect(q.sql).toMatch(/\) < \(\$\d+::timestamptz, \$\d+::uuid\)/);
      expect(q.params).toEqual(expect.arrayContaining(['2026-10-10T10:00:00.000Z', 'e1']));

      for (const bad of ['not-valid-base64-json!', Buffer.from('{"bad": 123}').toString('base64url')]) {
        const chain = makeQueryChain([]);
        db.select.mockReturnValueOnce(chain);
        await repo.listNotes('w1', 'c1', 'u1', { cursor: bad });
        expect(whereSql(chain).sql).not.toContain('::timestamptz');
      }
    });
  });

  describe('role rollup', () => {
    it('orders roles by confidence (high > medium > low), then emailCount desc', async () => {
      // Rows arrive in the query's order.
      db.execute.mockResolvedValueOnce({
        rows: [
          { label: 'funding', max_conf_rank: 3, email_count: 2, total_email_count: 7, evidence: 'Key evidence' },
          { label: 'advisory', max_conf_rank: 2, email_count: 5, total_email_count: 7, evidence: 'Key evidence' },
          { label: 'legal', max_conf_rank: 1, email_count: 10, total_email_count: 7, evidence: 'Key evidence' },
        ],
      });

      const rollup = await repo.getRoleRollup('w1', 'c1', 'u1');

      expect(dialect.sqlToQuery(db.execute.mock.calls[0][0] as SQL).sql).toContain(
        'ORDER BY pl.max_conf_rank DESC, pl.email_count DESC',
      );
      expect(rollup).toEqual({
        roles: [
          { label: 'funding', confidence: 'high', emailCount: 2 },
          { label: 'advisory', confidence: 'medium', emailCount: 5 },
          { label: 'legal', confidence: 'low', emailCount: 10 },
        ],
        emailCount: 7,
        evidence: 'Key evidence',
      });
    });
  });

  describe('note privacy', () => {
    it("returns only notes on emails the viewer is on or that are in the viewer's mailbox", async () => {
      const notesChain = makeQueryChain([]);
      db.select.mockReturnValueOnce(notesChain);
      await repo.listNotes('w1', 'c1', 'viewer-1');
      const q = whereSql(notesChain);
      expect(q.sql).toMatch(/vp\.email_id = \S*"emails"\."id" AND vp\.user_id = \$\d+/);
      expect(q.sql).toMatch(/lower\(vu\.email\) = lower\(\S*"emails"\."custodian_email"\)/);
      expect(q.params).toContain('viewer-1');
      // ...and only from mailboxes of this workspace's members.
      expect(q.sql).toMatch(/cu\.email = \S*"emails"\."custodian_email"\s+AND cuw\.workspace_id = \$\d+/);
      expect(q.params).toContain('w1');
    });

    it('returns no notes, without reading, when there is no viewer', async () => {
      const res = await repo.listNotes('w1', 'c1', '');
      expect(res).toEqual({ notes: [], nextCursor: null });
      expect(db.select).not.toHaveBeenCalled();
    });

    it('reads every note for the system read (no viewer filter), still within the workspace', async () => {
      const notesChain = makeQueryChain([]);
      db.select.mockReturnValueOnce(notesChain);
      await repo.listNotesForSystem('w1', 'c1', { limit: 30 });
      const q = whereSql(notesChain);
      expect(q.sql).not.toContain('vp.user_id');
      expect(q.sql).toContain('cuw.workspace_id');
    });

    it("counts every email for the role chips but takes the evidence only from the viewer's emails", async () => {
      await repo.getRoleRollup('w1', 'c1', 'viewer-1');
      const q = dialect.sqlToQuery(db.execute.mock.calls[0][0] as SQL);
      // The chips group over all signals; only the evidence sub-select is filtered.
      expect(q.sql).toMatch(/GROUP BY label/);
      expect(q.sql).toMatch(/SELECT evidence FROM signals WHERE \(EXISTS[\s\S]*vp\.email_id = signals\.email_id AND vp\.user_id = \$\d+/);
      expect(q.params).toContain('viewer-1');
    });

    it('gives no evidence without a viewer, and any evidence to the system overview job', async () => {
      await repo.getRoleRollup('w1', 'c1', '');
      expect(dialect.sqlToQuery(db.execute.mock.calls[0][0] as SQL).sql).toContain(
        'SELECT evidence FROM signals WHERE FALSE',
      );
      await repo.getRoleRollupForSystem('w1', 'c1');
      expect(dialect.sqlToQuery(db.execute.mock.calls[1][0] as SQL).sql).toContain(
        'SELECT evidence FROM signals WHERE TRUE',
      );
    });
  });

  describe('overview operations', () => {
    it('claimOverviewPending claims only a row no live job holds', async () => {
      db.insertQuery.returning.mockResolvedValueOnce([{ correspondentId: 'c1' }]);
      await expect(repo.claimOverviewPending('w1', 'c1')).resolves.toBe(true);
      expect(db.insertQuery.values).toHaveBeenCalledWith([
        { workspace_id: 'w1', correspondent_id: 'c1', status: 'pending' },
      ]);
      const conflict = db.insertQuery.onConflictDoUpdate.mock.calls[0][0];
      // Keeps the existing overview text: it is not in the update set.
      expect(conflict.set).not.toHaveProperty('overview');
      expect(conflict.set).toMatchObject({ status: 'pending', job_id: null });
      const where = dialect.sqlToQuery(conflict.setWhere as SQL);
      expect(where.sql).toMatch(/"status" <> 'pending'\s+OR "contact_relationship_overviews"\."updated_at" < now\(\) - make_interval\(mins => \$1\)/);
      expect(where.params).toEqual([5]);

      // A pending row a live job holds: the conditional update returns nothing.
      db.insertQuery.returning.mockResolvedValueOnce([]);
      await expect(repo.claimOverviewPending('w1', 'c1')).resolves.toBe(false);
    });

    it('claimOverviewsPending claims many in one statement and returns the ids it won', async () => {
      db.insertQuery.returning.mockResolvedValueOnce([{ correspondentId: 'c2' }]);
      await expect(repo.claimOverviewsPending('w1', ['c1', 'c2', 'c1'])).resolves.toEqual(['c2']);
      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(db.insertQuery.values).toHaveBeenCalledWith([
        { workspace_id: 'w1', correspondent_id: 'c1', status: 'pending' },
        { workspace_id: 'w1', correspondent_id: 'c2', status: 'pending' },
      ]);
      // Same guard as the single claim: never takes a row a live job holds.
      const where = dialect.sqlToQuery(db.insertQuery.onConflictDoUpdate.mock.calls[0][0].setWhere as SQL);
      expect(where.sql).toMatch(/"status" <> 'pending'\s+OR "contact_relationship_overviews"\."updated_at" < now\(\) - make_interval\(mins => \$1\)/);
    });

    it('setOverviewJobId stamps the job on the claimed rows', async () => {
      await repo.setOverviewJobId('w1', ['c1', 'c2'], 'job-9');
      expect(db.updateQuery.set).toHaveBeenCalledWith({ job_id: 'job-9' });
      expect(db.updateQuery.where).toHaveBeenCalled();
    });

    it('saveOverviewReady saves text, deal lines, role summary and inputHash', async () => {
      await repo.saveOverviewReady('w1', 'c1', {
        text: 'Overview prose.',
        inputHash: '3:email-1',
        dealNotes: [{ companyId: 'co-1', note: 'Asked for the data room.' }],
        roleSummary: 'Penny mostly negotiates facility terms.',
      });
      expect(db.update).toHaveBeenCalled();
      expect(db.updateQuery.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ready',
          overview: 'Overview prose.',
          deal_notes: [{ companyId: 'co-1', note: 'Asked for the data room.' }],
          role_summary: 'Penny mostly negotiates facility terms.',
          input_hash: '3:email-1',
        }),
      );
    });

    it('saveOverviewReady clears the deal lines and role summary it was not given', async () => {
      await repo.saveOverviewReady('w1', 'c1', {
        text: 'Overview prose.',
        inputHash: '3:email-1',
        dealNotes: [],
        roleSummary: null,
      });
      expect(db.updateQuery.set).toHaveBeenCalledWith(
        expect.objectContaining({ deal_notes: [], role_summary: null }),
      );
    });

    it('markOverviewFailed sets status to failed', async () => {
      await repo.markOverviewFailed('w1', 'c1');
      expect(db.update).toHaveBeenCalled();
      expect(db.updateQuery.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
        }),
      );
    });
  });

  describe('getNoteInputHash', () => {
    it('returns the active deal links with the note count', async () => {
      db.execute.mockResolvedValueOnce({
        rows: [{ note_count: 3, latest_email_id: 'e9', deal_company_ids: ['co-a', 'co-b'] }],
      });
      await expect(repo.getNoteInputHash('w1', 'c1')).resolves.toEqual({
        noteCount: 3,
        latestEmailId: 'e9',
        dealCompanyIds: ['co-a', 'co-b'],
      });
      const q = dialect.sqlToQuery(db.execute.mock.calls[0][0] as SQL);
      expect(q.sql).toContain('(array_agg(em.id::text ORDER BY em.sent_at DESC, em.id DESC))[1]');
      expect(q.sql).toContain('FROM "public"."deal_contacts" dc');
      expect(q.sql).toContain("AND dc.status = 'active'");
    });
  });

  describe('listOverviewRefreshCandidates', () => {
    it('reads contacts touched since the cut-off in one query, with their overview row', async () => {
      db.execute.mockResolvedValueOnce({
        rows: [
          {
            correspondent_id: 'c1',
            note_count: 4,
            latest_email_id: 'e4',
            deal_company_ids: ['co-1'],
            status: 'ready',
            input_hash: '3:e3',
            has_text: true,
            updated_at: '2026-10-20T00:00:00Z',
          },
          {
            correspondent_id: 'c2',
            note_count: 1,
            latest_email_id: 'e5',
            deal_company_ids: [],
            status: null,
            input_hash: null,
            has_text: false,
            updated_at: null,
          },
        ],
      });

      const rows = await repo.listOverviewRefreshCandidates('w1', '2026-10-21T00:00:00.000Z');

      expect(rows).toEqual([
        {
          correspondentId: 'c1',
          noteCount: 4,
          latestEmailId: 'e4',
          dealCompanyIds: ['co-1'],
          status: 'ready',
          inputHash: '3:e3',
          hasText: true,
          updatedAt: '2026-10-20T00:00:00.000Z',
        },
        {
          correspondentId: 'c2',
          noteCount: 1,
          latestEmailId: 'e5',
          dealCompanyIds: [],
          status: null,
          inputHash: null,
          hasText: false,
          updatedAt: null,
        },
      ]);
      expect(db.execute).toHaveBeenCalledTimes(1);
      const q = dialect.sqlToQuery(db.execute.mock.calls[0][0] as SQL);
      expect(q.sql).toMatch(/WHERE tn\.created_at >= \$\d+/);
      expect(q.sql).toContain('"public"."workspace_correspondents" wc');
      expect(q.sql).toContain('LEFT JOIN "public"."contact_relationship_overviews" o');
      expect(q.params).toContain('2026-10-21T00:00:00.000Z');
      expect(q.params).toContain('w1');
    });
  });

  describe('listDealEvidenceEmails', () => {
    it('maps related-company evidence and Smart Files emails to the deals', async () => {
      db.execute.mockResolvedValueOnce({
        rows: [{ company_id: 'co-1', email_id: 'e1' }],
      });
      await expect(repo.listDealEvidenceEmails('w1', 'c1', ['co-1', 'co-2'])).resolves.toEqual([
        { companyId: 'co-1', emailId: 'e1' },
      ]);
      const q = dialect.sqlToQuery(db.execute.mock.calls[0][0] as SQL);
      expect(q.sql).toContain('"analytics"."employer_related_company_evidence" ev');
      expect(q.sql).toContain('ON em.message_id = dc.evidence_message_id');
      expect(q.sql).toContain('AND erc.dismissed_at IS NULL');
    });
  });
});
