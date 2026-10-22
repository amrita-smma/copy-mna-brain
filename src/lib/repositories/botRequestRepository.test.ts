import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { BotRequestRepository, findStaleBotRequests } from './botRequestRepository';
import { botRequests } from '@/lib/db/schema';

const CHAIN = ['select', 'from', 'where', 'orderBy', 'insert', 'values', 'update', 'set'] as const;
type MockDb = Record<(typeof CHAIN)[number] | 'returning' | 'limit' | 'execute' | 'transaction', ReturnType<typeof vi.fn>>;

/**
 * A chainable Drizzle double. `where` is the terminal call for the group
 * count (no `.limit` / `.orderBy` after it), so it resolves to `whereResult`
 * while still being chainable for the other queries.
 */
function createMockDb(): MockDb {
  const mock = { returning: vi.fn(), limit: vi.fn(), execute: vi.fn(), transaction: vi.fn() } as MockDb;
  for (const k of CHAIN) mock[k] = vi.fn().mockReturnThis();
  mock.transaction.mockImplementation(async (fn: (tx: MockDb) => unknown) => fn(mock));
  return mock;
}

const dialect = new PgDialect();
const toQuery = (fragment: unknown) => dialect.sqlToQuery(fragment as SQL);

const row = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  workspace_id: 'ws-1',
  group_id: 'g1',
  status: 'pending',
  created_at: '2026-10-19T00:00:00Z',
  ...over,
});

describe('BotRequestRepository', () => {
  let db: MockDb;
  let repo: BotRequestRepository;

  beforeEach(() => {
    db = createMockDb();
    repo = new BotRequestRepository(db as never, 'ws-1');
  });

  describe('BotRequestRepository.createMany', () => {
    it('stamps the workspace on every row and skips the query for none', async () => {
      db.returning.mockResolvedValueOnce([row()]);

      const rows = await repo.createMany([
        {
          group_id: 'g1',
          user_id: 'u1',
          from_bot_id: 'a',
          from_bot_name: 'A',
          from_chat_id: 'chat-a',
          to_bot_id: 'b',
          to_bot_name: 'B',
          ask: 'q',
        },
      ]);
      await expect(repo.createMany([])).resolves.toEqual([]);

      expect(rows).toEqual([row()]);
      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(db.insert).toHaveBeenCalledWith(botRequests);
      expect(db.values.mock.calls[0][0][0]).toMatchObject({ workspace_id: 'ws-1', to_bot_id: 'b' });
    });
  });

  describe('BotRequestRepository.close', () => {
    /** Wire the chain for one close: the group lookup, the update, the pending count, the group read. */
    const arrange = (opts: { exists?: boolean; updated?: boolean; pending: number; group?: unknown[] }) => {
      db.limit.mockResolvedValueOnce(opts.exists === false ? [] : [{ group_id: 'g1' }]);
      db.returning.mockResolvedValueOnce(opts.updated === false ? [] : [row({ status: 'done' })]);
      // The count's `where` is terminal; the others chain on.
      db.where
        .mockReturnValueOnce(db) // the group lookup
        .mockReturnValueOnce(db) // the update
        .mockResolvedValueOnce([{ open: opts.pending }]) // the count
        .mockReturnValue(db); // the group read
      db.orderBy.mockResolvedValueOnce(opts.group ?? []);
    };

    it('takes the group lock, closes the row, and returns the group when it was the last open request', async () => {
      arrange({ pending: 0, group: [row({ id: 'r0', status: 'done' }), row({ status: 'done' })] });

      const result = await repo.close('r1', { status: 'done', answer: 'NAV is 1.2x.' });

      expect(db.transaction).toHaveBeenCalledTimes(1);
      const lock = toQuery(db.execute.mock.calls[0][0]);
      expect(lock.sql).toContain('pg_advisory_xact_lock(hashtext(');
      expect(lock.params).toEqual(['g1']);
      expect(db.set.mock.calls[0][0]).toMatchObject({ status: 'done', answer: 'NAV is 1.2x.' });
      // Only a pending row closes: a repeat (the job timed out, then finished) is a no-op.
      const updateWhere = toQuery(db.where.mock.calls[1][0]);
      expect(updateWhere.params).toEqual(['r1', 'ws-1', 'pending']);
      expect(result.closed).toMatchObject({ id: 'r1', status: 'done' });
      expect(result.group?.map((r) => (r as { id: string }).id)).toEqual(['r0', 'r1']);
    });

    it('returns no group while a sibling is still open', async () => {
      arrange({ pending: 1 });

      const result = await repo.close('r1', { status: 'failed', answer: 'boom' });

      expect(result.closed).not.toBeNull();
      expect(result.group).toBeNull();
      expect(db.orderBy).not.toHaveBeenCalled();
    });

    it('is a no-op for a request already closed, or unknown', async () => {
      arrange({ updated: false, pending: 0 });
      await expect(repo.close('r1', { status: 'done', answer: null })).resolves.toEqual({ closed: null, group: null });

      db = createMockDb();
      repo = new BotRequestRepository(db as never, 'ws-1');
      db.limit.mockResolvedValueOnce([]);
      await expect(repo.close('missing', { status: 'done', answer: null })).resolves.toEqual({ closed: null, group: null });
      expect(db.execute).not.toHaveBeenCalled();
    });
  });

  describe('BotRequestRepository.findStale / findStaleBotRequests', () => {
    it('reads open requests older than the cutoff, oldest first, in this workspace', async () => {
      db.limit.mockResolvedValueOnce([row()]);

      await expect(repo.findStale(660, 50)).resolves.toEqual([row()]);

      const where = toQuery(db.where.mock.calls[0][0]);
      expect(where.params).toEqual(['ws-1', 'pending', 660]);
      expect(where.sql).toContain('make_interval(secs =>');
      expect(db.limit).toHaveBeenCalledWith(50);
    });

    it('reads across workspaces only for the cron sweep', async () => {
      db.limit.mockResolvedValueOnce([{ id: 'r1', workspace_id: 'ws-2' }]);

      await expect(findStaleBotRequests(db as never, 660, 50)).resolves.toEqual([{ id: 'r1', workspace_id: 'ws-2' }]);

      const where = toQuery(db.where.mock.calls[0][0]);
      expect(where.params).toEqual(['pending', 660]);
    });
  });
});
