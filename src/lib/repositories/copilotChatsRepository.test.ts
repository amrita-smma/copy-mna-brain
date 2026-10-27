import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { CopilotChatsRepository } from './copilotChatsRepository';

interface MockDb {
  select: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
  where: ReturnType<typeof vi.fn>;
  orderBy: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  offset: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  values: ReturnType<typeof vi.fn>;
  returning: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  onConflictDoNothing: ReturnType<typeof vi.fn>;
}

describe('CopilotChatsRepository', () => {
  let mockDb: MockDb;
  let repo: CopilotChatsRepository;

  beforeEach(() => {
    mockDb = {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn(),
      limit: vi.fn(),
      offset: vi.fn(),
      insert: vi.fn().mockReturnThis(),
      values: vi.fn().mockReturnThis(),
      returning: vi.fn(),
      update: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      onConflictDoNothing: vi.fn().mockReturnThis(),
    };
    repo = new CopilotChatsRepository(mockDb as never, 'workspace-1');
  });

  // last_active_at alone is not unique: chats touched in the same transaction
  // share a timestamp, and without a tiebreak Postgres may order them
  // differently per query — the same row would appear on two pages while
  // another never appears at all.

  it('getById returns the row when found', async () => {
    const row = { id: 'c1', user_id: 'u1' };
    mockDb.limit.mockResolvedValueOnce([row]);

    const result = await repo.getById('c1');

    expect(result).toEqual(row);
  });

  it('getById returns null when not found', async () => {
    mockDb.limit.mockResolvedValueOnce([]);

    const result = await repo.getById('missing');

    expect(result).toBeNull();
  });

  it('touchLastActive issues an update with sql now()', async () => {
    mockDb.set.mockReturnThis();
    mockDb.where.mockResolvedValueOnce(undefined);

    await repo.touchLastActive('c1');

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    expect(mockDb.set).toHaveBeenCalledTimes(1);
  });

  it('pinAgentKey writes the key and returns it when the thread was unresolved', async () => {
    mockDb.returning.mockResolvedValueOnce([{ agent_key: 'bangun' }]);

    const result = await repo.pinAgentKey('c1', 'bangun');

    expect(result).toBe('bangun');
    expect(mockDb.set).toHaveBeenCalledWith({ agent_key: 'bangun' });
    // Lost-race fallback read not needed.
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('pinAgentKey keeps and returns the stored key when the thread is already pinned', async () => {
    // The guarded UPDATE matches no row …
    mockDb.returning.mockResolvedValueOnce([]);
    // … so the stored key is read back.
    mockDb.limit.mockResolvedValueOnce([{ agent_key: 'general' }]);

    const result = await repo.pinAgentKey('c1', 'bangun');

    expect(result).toBe('general');
    expect(mockDb.update).toHaveBeenCalledTimes(1);
  });

  it('pinAgentKey returns null when the chat is not in this workspace', async () => {
    mockDb.returning.mockResolvedValueOnce([]);
    mockDb.limit.mockResolvedValueOnce([]);

    await expect(repo.pinAgentKey('missing', 'bangun')).resolves.toBeNull();
  });

  describe('CopilotChatsRepository.findOrCreateBotThread', () => {
    it('returns the existing bot thread in one query without inserting', async () => {
      const thread = { id: 'chat-1', bot_id: 'bot-1' };
      mockDb.limit.mockResolvedValueOnce([thread]);

      await expect(repo.findOrCreateBotThread('u1', 'bot-1', 'Deal Scout')).resolves.toBe(thread);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("creates the thread on first open, pinned to the general agent and titled with the bot's name", async () => {
      const created = { id: 'chat-2', bot_id: 'bot-1' };
      mockDb.limit.mockResolvedValueOnce([]);
      mockDb.returning.mockResolvedValueOnce([created]);

      await expect(repo.findOrCreateBotThread('u1', 'bot-1', 'Deal Scout')).resolves.toBe(created);
      expect(mockDb.values).toHaveBeenCalledWith({
        user_id: 'u1',
        workspace_id: 'workspace-1',
        bot_id: 'bot-1',
        agent_key: 'general',
        title: 'Deal Scout',
      });
      expect(mockDb.onConflictDoNothing).toHaveBeenCalled();
    });

    it('finds the thread on its own, for a caller that creates it only when the find comes back empty', async () => {
      const thread = { id: 'chat-1', bot_id: 'bot-1' };
      mockDb.limit.mockResolvedValueOnce([thread]).mockResolvedValueOnce([]);

      await expect(repo.findBotThread('u1', 'bot-1')).resolves.toBe(thread);
      await expect(repo.findBotThread('u1', 'bot-1')).resolves.toBeNull();
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('reads the row a concurrent open inserted when its own insert hits the unique index', async () => {
      const raced = { id: 'chat-3', bot_id: 'bot-1' };
      mockDb.limit.mockResolvedValueOnce([]).mockResolvedValueOnce([raced]);
      mockDb.returning.mockResolvedValueOnce([]);

      await expect(repo.findOrCreateBotThread('u1', 'bot-1', 'Deal Scout')).resolves.toBe(raced);
    });
  });

  describe('CopilotChatsRepository turn lock, history import and unread', () => {
    const dialect = new PgDialect();
    const whereSql = () => dialect.sqlToQuery(mockDb.where.mock.calls[0][0] as SQL);

    it('claims the turn lock only when it is free or expired', async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: 'c1' }]).mockResolvedValueOnce([]);

      await expect(repo.claimTurn('c1', 600)).resolves.toBe(true);
      await expect(repo.claimTurn('c1', 600)).resolves.toBe(false);

      const where = whereSql();
      expect(where.sql).toContain('"busy_until" is null or "copilot_chats"."busy_until" < now()');
      expect(where.params).toEqual(['c1', 'workspace-1']);
    });

    it('reports whether a turn holds the lock right now', async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: 'c1' }]).mockResolvedValueOnce([]);

      await expect(repo.isTurnRunning('c1')).resolves.toBe(true);
      await expect(repo.isTurnRunning('c1')).resolves.toBe(false);

      const where = whereSql();
      expect(where.sql).toContain('"copilot_chats"."busy_until" > now()');
      expect(where.params).toEqual(['c1', 'workspace-1']);
    });

    it('stamps a reply, and marks the thread read only for an interactive one', async () => {
      await repo.stampMessage('c1', { read: true });
      await repo.stampMessage('c1', { read: false });

      expect(Object.keys(mockDb.set.mock.calls[0][0])).toEqual(['last_message_at', 'last_read_at']);
      expect(Object.keys(mockDb.set.mock.calls[1][0])).toEqual(['last_message_at']);
    });

    it('releases the lock and marks read within this workspace', async () => {
      await repo.releaseTurn('c1');
      await repo.markRead('c1');

      expect(mockDb.set.mock.calls[0][0]).toEqual({ busy_until: null });
      expect(Object.keys(mockDb.set.mock.calls[1][0])).toEqual(['last_read_at']);
      expect(whereSql().params).toEqual(['c1', 'workspace-1']);
    });

    it('marks a thread unread by clearing its read time, within this workspace', async () => {
      await repo.markUnread('c1');

      expect(mockDb.set.mock.calls[0][0]).toEqual({ last_read_at: null });
      expect(whereSql().params).toEqual(['c1', 'workspace-1']);
    });
  });
});
