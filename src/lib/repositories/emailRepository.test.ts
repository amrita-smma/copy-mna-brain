import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { EmailRepository } from './emailRepository';

function makeDb() {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
  };
}

describe('EmailRepository workspace visibility', () => {
  let db: ReturnType<typeof makeDb>;
  let repo: EmailRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new EmailRepository(db as never);
  });

  function whereSql(callIndex = 0): string {
    const arg = db.where.mock.calls[callIndex]?.[0];
    return new PgDialect().sqlToQuery(arg).sql;
  }

  describe('countSince', () => {
    it('scopes to the workspace via workspace_correspondents alone — no email-sync gate', async () => {
      db.where.mockResolvedValueOnce([{ n: 7 }]);

      const out = await repo.countSince('2026-01-01', 'w1');

      expect(out).toBe(7);
      const text = whereSql();
      expect(text).toContain('workspace_correspondents');
      expect(text).not.toContain("!= 'ingest'");
      expect(text).not.toContain('user_workspaces');
      expect(text).not.toContain('is_email_synced');
    });

    it('returns 0 when the count row is missing', async () => {
      db.where.mockResolvedValueOnce([]);
      expect(await repo.countSince('2026-01-01', 'w1')).toBe(0);
    });
  });

  describe('deleteByMessageIdsCreatedBefore', () => {
    function makeDeleteDb() {
      return {
        delete: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        returning: vi.fn().mockResolvedValue([
          { message_id: 'm1', custodian_email: 'a@starcapital.co.id' },
          { message_id: 'm2', custodian_email: 'b@starcapital.co.id' },
        ]),
      };
    }

    it('returns [] without hitting the DB when the id list is empty', async () => {
      const del = makeDeleteDb();
      const out = await new EmailRepository(del as never).deleteByMessageIdsCreatedBefore(
        [],
        '2026-10-22T00:00:00Z',
      );
      expect(out).toEqual([]);
      expect(del.delete).not.toHaveBeenCalled();
    });

    it('deletes only the given Message-IDs created before the cutoff', async () => {
      const del = makeDeleteDb();
      const out = await new EmailRepository(del as never).deleteByMessageIdsCreatedBefore(
        ['m1', 'm2'],
        '2026-10-22T00:00:00Z',
      );
      expect(out).toHaveLength(2);
      expect(del.returning).toHaveBeenCalledWith({
        message_id: expect.anything(),
        custodian_email: expect.anything(),
      });
      const query = new PgDialect().sqlToQuery(del.where.mock.calls[0][0]);
      expect(query.sql).toContain('"message_id" in');
      expect(query.sql).toContain('"created_at" <');
      expect(query.params).toEqual(['m1', 'm2', '2026-10-22T00:00:00Z']);
    });
  });

  describe('countStaleEmployers', () => {
    it('counts ingest-derived employers without requiring an email-synced member', async () => {
      db.where.mockResolvedValueOnce([{ n: 3 }]);

      const out = await repo.countStaleEmployers('2026-01-01', 'w1');

      expect(out).toBe(3);
      const text = whereSql();
      expect(text).toContain('workspace_correspondents');
      expect(text).not.toContain("!= 'ingest'");
      expect(text).not.toContain('user_workspaces');
      expect(text).not.toContain('is_email_synced');
    });
  });
});
