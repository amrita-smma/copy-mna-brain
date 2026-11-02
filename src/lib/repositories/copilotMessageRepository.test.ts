import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { CopilotMessageRepository, findUnembeddedChatMessages } from './copilotMessageRepository';
import { copilotMessages } from '@/lib/db/schema';

const CHAIN = ['select', 'from', 'where', 'orderBy', 'insert', 'values', 'update', 'set', 'delete'] as const;
type MockDb = Record<(typeof CHAIN)[number] | 'returning' | 'limit' | 'execute', ReturnType<typeof vi.fn>>;

function createMockDb(): MockDb {
  const mock = { returning: vi.fn(), limit: vi.fn(), execute: vi.fn() } as MockDb;
  for (const k of CHAIN) mock[k] = vi.fn().mockReturnThis();
  return mock;
}

const dialect = new PgDialect();
const toQuery = (fragment: unknown) => dialect.sqlToQuery(fragment as SQL);
const vec = (n = 1024) => Array.from({ length: n }, () => 0.1);

describe('CopilotMessageRepository', () => {
  let db: MockDb;
  let repo: CopilotMessageRepository;

  beforeEach(() => {
    db = createMockDb();
    repo = new CopilotMessageRepository(db as never, 'ws-1');
  });

  describe('CopilotMessageRepository.findByToolCallId', () => {
    it("finds the thread's reply holding the call by jsonb containment, scoped to the workspace", async () => {
      db.limit.mockResolvedValueOnce([{ id: 'm1' }]);

      await expect(repo.findByToolCallId('chat-1', 'toolu_1')).resolves.toEqual({ id: 'm1' });

      const { sql: text, params } = toQuery(db.where.mock.calls[0][0]);
      expect(text).toContain('@>');
      expect(params).toEqual(
        expect.arrayContaining([
          'chat-1',
          'ws-1',
          'assistant',
          JSON.stringify([{ type: 'dynamic-tool', toolCallId: 'toolu_1' }]),
        ]),
      );
      expect(db.limit).toHaveBeenCalledWith(1);
    });

    it('resolves null when no reply holds the call', async () => {
      db.limit.mockResolvedValueOnce([]);
      await expect(repo.findByToolCallId('chat-1', 'toolu_x')).resolves.toBeNull();
    });
  });

  describe('CopilotMessageRepository.insertMany', () => {
    it('stamps the workspace on every row and skips the query for none', async () => {
      db.returning.mockResolvedValueOnce([{ id: 'm1', role: 'user' }]);

      await repo.insertMany([
        { chat_id: 'c', user_id: 'u', bot_id: null, role: 'user', parts: [], text: 'q' },
      ]);
      await expect(repo.insertMany([])).resolves.toEqual([]);

      expect(db.insert).toHaveBeenCalledTimes(1);
      expect(db.insert).toHaveBeenCalledWith(copilotMessages);
      expect(db.values.mock.calls[0][0][0]).toMatchObject({ workspace_id: 'ws-1', text: 'q' });
    });
  });

  describe('CopilotMessageRepository.deleteById', () => {
    it('deletes one row, in this workspace only', async () => {
      db.where.mockResolvedValueOnce(undefined);

      await repo.deleteById('m1');

      expect(db.delete).toHaveBeenCalledWith(copilotMessages);
      const where = toQuery(db.where.mock.calls[0][0]);
      expect(where.params).toEqual(['m1', 'ws-1']);
    });
  });

  describe('CopilotMessageRepository.listPage', () => {
    it('reads one extra row to detect an earlier page and returns the page oldest first', async () => {
      db.limit.mockResolvedValueOnce([{ seq: 9 }, { seq: 8 }, { seq: 7 }]);

      const page = await repo.listPage('chat-1', { before: 10, limit: 2 });

      expect(db.limit).toHaveBeenCalledWith(3);
      expect(page).toEqual({ rows: [{ seq: 8 }, { seq: 9 }], hasMore: true });
      const where = toQuery(db.where.mock.calls[0][0]);
      expect(where.params).toEqual(['chat-1', 'ws-1', 10]);
    });

    it('clamps the page size', async () => {
      db.limit.mockResolvedValueOnce([]);
      await repo.listPage('chat-1', { limit: 10_000 });
      expect(db.limit).toHaveBeenCalledWith(101);
    });
  });

  describe('CopilotMessageRepository.listTurnsPage', () => {
    it('starts the page at the oldest of the last N user rows and flags an earlier page', async () => {
      // User rows (turn starts), newest first, one more than asked for.
      db.limit
        .mockResolvedValueOnce([{ seq: 9 }, { seq: 5 }, { seq: 1 }])
        .mockResolvedValueOnce([{ seq: 5 }, { seq: 6 }, { seq: 9 }, { seq: 10 }]);

      const page = await repo.listTurnsPage('chat-1', { turns: 2 });

      expect(db.limit.mock.calls[0][0]).toBe(3);
      expect(toQuery(db.where.mock.calls[0][0]).params).toEqual(['chat-1', 'ws-1', 'user']);
      // Every row from the second-newest turn's start on, oldest first.
      expect(toQuery(db.where.mock.calls[1][0]).params).toEqual(['chat-1', 'ws-1', 5]);
      expect(page).toEqual({ rows: [{ seq: 5 }, { seq: 6 }, { seq: 9 }, { seq: 10 }], hasMore: true });
    });

    it('reads everything before the cursor when fewer turns remain', async () => {
      db.limit.mockResolvedValueOnce([{ seq: 3 }]).mockResolvedValueOnce([{ seq: 2 }, { seq: 3 }, { seq: 4 }]);

      const page = await repo.listTurnsPage('chat-1', { before: 5, turns: 5 });

      expect(toQuery(db.where.mock.calls[0][0]).params).toEqual(['chat-1', 'ws-1', 5, 'user']);
      // No lower bound: rows before the first user row come along.
      expect(toQuery(db.where.mock.calls[1][0]).params).toEqual(['chat-1', 'ws-1', 5]);
      expect(page.hasMore).toBe(false);
      expect(page.rows).toHaveLength(3);
    });
  });

  describe('CopilotMessageRepository.setEmbedding', () => {
    it('rejects a vector of the wrong size before touching the database', async () => {
      await expect(repo.setEmbedding('m1', vec(3))).rejects.toThrow('1024');
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe('CopilotMessageRepository.hybridSearch', () => {
    it("is scoped to one user's replies in this workspace and fuses vector and full-text ranks", async () => {
      db.execute.mockResolvedValueOnce({ rows: [{ id: 'm1', score: '0.03' }] });

      const hits = await repo.hybridSearch({
        userId: 'u1',
        botId: 'b1',
        query: 'acme multiple',
        embedding: vec(),
        limit: 5,
      });

      expect(hits).toEqual([{ id: 'm1', score: 0.03 }]);
      const q = toQuery(db.execute.mock.calls[0][0]);
      expect(q.sql).toContain('m.user_id = $');
      expect(q.sql).toContain("m.role = 'assistant'");
      expect(q.sql).toContain('m.bot_id = $');
      expect(q.sql).toContain('<=>');
      expect(q.sql).toContain("plainto_tsquery('simple'");
      expect(q.params).toEqual(expect.arrayContaining(['u1', 'ws-1', 'b1', 'acme multiple']));
    });

    it('searches full text only when there is no embedding', async () => {
      db.execute.mockResolvedValueOnce({ rows: [] });

      await repo.hybridSearch({ userId: 'u1', query: 'acme', embedding: null, limit: 5 });

      const q = toQuery(db.execute.mock.calls[0][0]);
      expect(q.sql).not.toContain('<=>');
      expect(q.sql).not.toContain('m.bot_id = $');
    });

    it('returns nothing for a blank query without querying', async () => {
      await expect(repo.hybridSearch({ userId: 'u1', query: '  ', embedding: null, limit: 5 })).resolves.toEqual([]);
      expect(db.execute).not.toHaveBeenCalled();
    });
  });
});

describe('findUnembeddedChatMessages', () => {
  it('reads assistant rows without a vector, newest first, across workspaces, for the cron backfill', async () => {
    const db = createMockDb();
    db.limit.mockResolvedValueOnce([{ id: 'm1', workspace_id: 'ws-2' }]);

    await expect(findUnembeddedChatMessages(db as never, 40)).resolves.toEqual([{ id: 'm1', workspace_id: 'ws-2' }]);

    // The chainable double records the subquery's `where` first, then the outer one.
    const inner = toQuery(db.where.mock.calls[0][0]);
    expect(inner.params).toEqual(['chat_message_embedding', 'pending', 'running']);
    expect(inner.sql).toContain("->'messageIds' ?");
    const where = toQuery(db.where.mock.calls[1][0]);
    expect(where.sql).toContain('"role" = ');
    expect(where.sql).toContain('"embedding" is null');
    expect(where.sql).toContain('"text" <> ');
    expect(where.params.slice(0, 2)).toEqual(['assistant', '']);
    // A row an embedding job already holds is skipped, so a tick never queues it twice.
    expect(where.sql).toContain('not exists');
    expect(where.sql).not.toContain('workspace_id');
    expect(toQuery(db.orderBy.mock.calls[0][0]).sql).toContain('desc');
    expect(db.limit).toHaveBeenCalledWith(40);
  });
});
