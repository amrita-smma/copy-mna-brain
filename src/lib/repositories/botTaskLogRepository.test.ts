import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { BotTaskLogRepository } from './botTaskLogRepository';

const CHAIN = ['select', 'from', 'leftJoin', 'where', 'orderBy', 'insert', 'values'] as const;
type MockDb = Record<(typeof CHAIN)[number] | 'returning' | 'limit', ReturnType<typeof vi.fn>>;

function createMockDb(): MockDb {
  const mock = { returning: vi.fn(), limit: vi.fn() } as MockDb;
  for (const k of CHAIN) mock[k] = vi.fn().mockReturnThis();
  return mock;
}

const dialect = new PgDialect();
const toQuery = (fragment: unknown) => dialect.sqlToQuery(fragment as SQL);

describe('BotTaskLogRepository', () => {
  let mockDb: MockDb;
  let repo: BotTaskLogRepository;

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new BotTaskLogRepository(mockDb as never, 'ws-1');
  });

  describe('BotTaskLogRepository.insert', () => {
    it('stamps the workspace on the row', async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: 't1' }]);
      await repo.insert({ bot_id: 'b1', user_id: 'u1', chat_id: 'c1', routine_id: null, source: 'chat', summary: 'Did it' });
      expect(mockDb.values).toHaveBeenCalledWith(expect.objectContaining({ workspace_id: 'ws-1', summary: 'Did it' }));
    });
  });

  describe('BotTaskLogRepository.listForUser', () => {
    it("reads the user's own tasks and every routine run on the bot, newest first, one extra row to tell if more exist", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: 't3' }, { id: 't2' }, { id: 't1' }]);

      const page = await repo.listForUser('b1', 'u1', { limit: 2 });

      expect(page).toEqual({ rows: [{ id: 't3' }, { id: 't2' }], hasMore: true });
      expect(mockDb.limit).toHaveBeenCalledWith(3);
      const where = toQuery(mockDb.where.mock.calls[0][0]);
      expect(where.sql).toContain('"bot_task_logs"."workspace_id" = $1');
      expect(where.sql).toContain('"bot_task_logs"."bot_id" = $2');
      expect(where.sql).toContain('("bot_task_logs"."user_id" = $3 or "bot_task_logs"."routine_id" is not null)');
      expect(where.params).toEqual(['ws-1', 'b1', 'u1']);
      expect(mockDb.leftJoin).toHaveBeenCalledTimes(1);
    });

    it("with ownOnly, reads only the user's own rows (Brain Bot)", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await repo.listForUser('b1', 'u1', { limit: 30, ownOnly: true });

      const where = toQuery(mockDb.where.mock.calls[0][0]);
      expect(where.sql).toContain('"bot_task_logs"."user_id" = $3');
      expect(where.sql).not.toContain('"routine_id" is not null');
    });

    it('pages back from a cursor on (created_at, id)', async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await repo.listForUser('b1', 'u1', { limit: 30, before: { createdAt: '2026-10-15T00:00:00Z', id: 't9' } });

      const where = toQuery(mockDb.where.mock.calls[0][0]);
      expect(where.sql).toContain('("bot_task_logs"."created_at", "bot_task_logs"."id") < ($4::timestamptz, $5::uuid)');
      expect(where.params.slice(3)).toEqual(['2026-10-15T00:00:00Z', 't9']);
    });
  });
});
