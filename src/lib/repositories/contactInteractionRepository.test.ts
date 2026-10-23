import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { ContactInteractionRepository } from './contactInteractionRepository';

function makeDb() {
  return { execute: vi.fn().mockResolvedValue({ rows: [] }) };
}

function compiled(db: ReturnType<typeof makeDb>, call = 0) {
  return new PgDialect().sqlToQuery(db.execute.mock.calls[call]?.[0] as SQL);
}

const NOW = new Date('2026-10-17T12:00:00.000Z');

describe('ContactInteractionRepository', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: ContactInteractionRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new ContactInteractionRepository(db as never);
  });

  describe('empty id lists', () => {
    it('returns [] without hitting the DB for every bulk read', async () => {
      await expect(repo.listEmailInteractions('w1', [])).resolves.toEqual([]);
      await expect(repo.listEmailTotals('w1', [])).resolves.toEqual([]);
      await expect(repo.listRelatedCompaniesForContacts('w1', [])).resolves.toEqual([]);
      await expect(repo.listUserContactActivity('w1', [], NOW, NOW)).resolves.toEqual([]);
      expect(db.execute).not.toHaveBeenCalled();
    });
  });

  describe('listEmailInteractions', () => {
    it('reads the mart for this workspace and these contacts in one query', async () => {
      await repo.listEmailInteractions('w1', ['c1', 'c2']);

      expect(db.execute).toHaveBeenCalledTimes(1);
      const { sql, params } = compiled(db);
      expect(sql).toContain('"analytics"."mart_contact_interactions"');
      expect(sql).toContain('mci.workspace_id = $1');
      expect(sql).toContain('mci.correspondent_id IN ($2, $3)');
      expect(params).toEqual(['w1', 'c1', 'c2']);
    });
  });

  describe('listEmailTotals', () => {
    it('reads the per-contact totals mart for this workspace and these contacts in one query', async () => {
      await repo.listEmailTotals('w1', ['c1', 'c2']);

      expect(db.execute).toHaveBeenCalledTimes(1);
      const { sql, params } = compiled(db);
      expect(sql).toContain('"analytics"."mart_contact_email_totals"');
      expect(sql).toContain('t.workspace_id = $1');
      expect(sql).toContain('t.correspondent_id IN ($2, $3)');
      expect(params).toEqual(['w1', 'c1', 'c2']);
    });
  });

  describe('listRelatedCompaniesForContacts', () => {
    it('scopes related companies and their evidence emails to the workspace and hides unmatched / dismissed rows', async () => {
      await repo.listRelatedCompaniesForContacts('w1', ['c1']);

      const { sql, params } = compiled(db);
      expect(sql).toContain('erc.workspace_id = $2');
      expect(sql).toContain('erc.dismissed_at IS NULL');
      expect(sql).toContain('erc.company_id IS NOT NULL');
      expect(sql).toContain('cuw.workspace_id = $3');
      expect(sql).toContain('GROUP BY ep.correspondent_id, erc.company_id');
      expect(params).toEqual(['c1', 'w1', 'w1']);
    });
  });

  describe('listUserContactActivity', () => {
    const SINCE = new Date('2026-10-03T12:00:00.000Z');

    it('reads only the listed users in this workspace, in one query', async () => {
      await repo.listUserContactActivity('w1', ['u1'], NOW, SINCE);

      expect(db.execute).toHaveBeenCalledTimes(1);
      const { sql, params } = compiled(db);
      expect(sql).toContain('"analytics"."mart_contact_interactions"');
      expect(sql).not.toContain('meeting');
      expect(sql).toContain('mci.user_id IN (');
      expect(sql).toContain('up.user_id IN (');
      // Every source and the visibility join are pinned to the workspace.
      expect(sql).toContain('mci.workspace_id = $');
      expect(sql).toContain('uw.workspace_id = $');
      expect(sql).toContain('cuw.workspace_id = $');
      expect(sql).toContain('wc.workspace_id = $');
      expect(params.filter((p) => p === 'w1').length).toBe(4);
      expect(params.filter((p) => p === 'u1').length).toBe(2);
      expect(params).not.toContain('u2');
    });

    it('windows the recent email count to [since, now]', async () => {
      await repo.listUserContactActivity('w1', ['u1'], NOW, SINCE);

      const { sql, params } = compiled(db);
      expect(sql).toMatch(/em\.sent_at >= \$\d+/);
      expect(sql).toMatch(/em\.sent_at <= \$\d+/);
      expect(params).toContain(NOW.toISOString());
      expect(params).toContain(SINCE.toISOString());
    });

    it('keeps the mart pair rule and the CRM visibility joins', async () => {
      await repo.listUserContactActivity('w1', ['u1', 'u2'], NOW, SINCE);

      const { sql } = compiled(db);
      expect(sql).toContain("(up.role = 'from' AND cp.role IN ('to', 'cc'))");
      expect(sql).toContain("(cp.role = 'from' AND up.role IN ('to', 'cc'))");
      expect(sql).toContain('cp.user_id IS NULL');
      expect(sql).toContain('"public"."correspondent_effective" ce');
      expect(sql).toContain('"public"."workspace_correspondents" wc');
      expect(sql).toContain("ee.curation_status = 'published'");
    });

    it('maps a row as node-postgres returns it (text counts and timestamps)', async () => {
      db.execute.mockResolvedValueOnce({
        rows: [
          {
            user_id: 'u1',
            correspondent_id: 'c1',
            contact_name: 'Jimmy Sprinkles',
            firm_name: 'Golden Sacks',
            emails_from_us: '2',
            emails_from_them: '3',
            last_email_at: '2026-10-14 10:00:00+00',
            recent_emails: 4,
          },
        ],
      });

      await expect(repo.listUserContactActivity('w1', ['u1'], NOW, SINCE)).resolves.toEqual([
        {
          userId: 'u1',
          correspondentId: 'c1',
          contactName: 'Jimmy Sprinkles',
          firmName: 'Golden Sacks',
          emailsFromUs: 2,
          emailsFromThem: 3,
          lastEmailAt: '2026-10-14T10:00:00.000Z',
          recentEmails: 4,
        },
      ]);
    });
  });

  describe('workspaceHasSyncedData', () => {
    it('checks emails through the workspace custodian bridge', async () => {
      db.execute.mockResolvedValueOnce({ rows: [{ has_data: true }] });

      await expect(repo.workspaceHasSyncedData('w1')).resolves.toBe(true);
      const { sql, params } = compiled(db);
      expect(sql).toContain('"analytics"."emails"');
      expect(sql).not.toContain('meeting');
      expect(params).toEqual(['w1']);
    });

    it('is false when the workspace has no synced email', async () => {
      db.execute.mockResolvedValueOnce({ rows: [{ has_data: false }] });
      await expect(repo.workspaceHasSyncedData('w1')).resolves.toBe(false);
    });
  });
});
