import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { BotRepository } from './botRepository';
import { botOrders, bots } from '@/lib/db/schema';

const CHAIN = [
  'select',
  'from',
  'leftJoin',
  'where',
  'orderBy',
  'limit',
  'insert',
  'values',
  'onConflictDoNothing',
  'onConflictDoUpdate',
  'update',
  'set',
] as const;
type MockDb = Record<(typeof CHAIN)[number] | 'returning', ReturnType<typeof vi.fn>>;

function createMockDb(): MockDb {
  const mock = { returning: vi.fn() } as MockDb;
  for (const k of CHAIN) mock[k] = vi.fn().mockReturnThis();
  return mock;
}

const dialect = new PgDialect();
const toQuery = (fragment: unknown) => dialect.sqlToQuery(fragment as SQL);

describe('BotRepository', () => {
  let mockDb: MockDb;
  let repo: BotRepository;
  const workspaceId = 'ws-1';

  beforeEach(() => {
    mockDb = createMockDb();
    repo = new BotRepository(mockDb as never, workspaceId);
  });

  describe('BotRepository.listVisible', () => {
    it("returns workspace bots plus the user's own private bots in one query, Brain Bot first", async () => {
      const rows = [{ id: 'b1' }];
      mockDb.orderBy.mockResolvedValueOnce(rows);

      await expect(repo.listVisible('user-1')).resolves.toBe(rows);

      expect(mockDb.select).toHaveBeenCalledTimes(1);
      expect(mockDb.from).toHaveBeenCalledWith(bots);
      // The user's own thread with each bot decides its unread dot.
      const select = mockDb.select.mock.calls[0][0] as Record<string, unknown>;
      expect(toQuery(select.unread).sql).toContain('"last_message_at" > coalesce("copilot_chats"."last_read_at"');
      // A held turn lock means the bot is answering right now.
      expect(toQuery(select.busy).sql).toBe('coalesce("copilot_chats"."busy_until" > now(), false)');
      const join = toQuery(mockDb.leftJoin.mock.calls[0][1]);
      expect(join.params).toEqual(['user-1', workspaceId]);
      const where = toQuery(mockDb.where.mock.calls[0][0]);
      expect(where.params).toEqual([workspaceId, 'workspace', 'user-1']);
      expect(where.sql).toContain('"archived_at" is null');
      expect(where.sql).toContain('"visibility" = $2 or "bots"."owner_user_id" = $3');
      // Brain Bot (the default bot) first, then pinned bots in the user's order, then the rest by newest activity.
      const orderJoin = toQuery(mockDb.leftJoin.mock.calls[1][1]);
      expect(mockDb.leftJoin.mock.calls[1][0]).toBe(botOrders);
      expect(orderJoin.params).toEqual(['user-1', workspaceId]);
      const order = mockDb.orderBy.mock.calls[0].map((c: unknown) => toQuery(c).sql);
      expect(order[0]).toContain('"is_default" desc');
      expect(order[1]).toBe('array_position("bot_orders"."bot_ids", "bots"."id") asc nulls last');
      expect(order[2]).toBe('"copilot_chats"."last_message_at" desc nulls last');
      expect(toQuery(select.pinned).sql).toBe('(array_position("bot_orders"."bot_ids", "bots"."id") is not null)');
      expect(select.last_activity_at).toBeDefined();
      // The preview is the thread's newest message with text, read in the same query.
      const preview = toQuery(select.last_message);
      expect(preview.sql).toContain('from copilot_messages m');
      expect(preview.sql).toContain('m.chat_id = "copilot_chats"."id"');
      expect(preview.sql).toContain("m.text <> ''");
      expect(preview.sql).toContain('order by m.seq desc');
      expect(preview.params).toEqual([280]);
    });
  });

  describe('BotRepository.findById', () => {
    it('scopes the lookup to this workspace and leaves out archived bots', async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      await expect(repo.findById('b1')).resolves.toBeNull();

      const where = toQuery(mockDb.where.mock.calls[0][0]);
      expect(where.params).toEqual([workspaceId, 'b1']);
      expect(where.sql).toContain('"archived_at" is null');
    });
  });

  describe('BotRepository.ensureDefault', () => {
    it('inserts an owner-less default bot, ignores a conflict, then reads the default back', async () => {
      const def = { id: 'def', is_default: true };
      mockDb.limit.mockResolvedValueOnce([def]);

      await expect(
        repo.ensureDefault({
          name: 'Copilot',
          system_prompt: '',
          base_flavor: 'mna',
          avatar: {},
          visibility: 'workspace',
        }),
      ).resolves.toBe(def);

      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({ workspace_id: workspaceId, is_default: true, owner_user_id: null }),
      );
      expect(mockDb.onConflictDoNothing).toHaveBeenCalled();
    });
  });

  describe('BotRepository.create', () => {
    it('stamps the workspace on the new bot', async () => {
      const row = { id: 'b2' };
      mockDb.returning.mockResolvedValueOnce([row]);

      await expect(
        repo.create({ name: 'Scout', owner_user_id: 'user-1', base_flavor: 'mna' }),
      ).resolves.toBe(row);
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({ workspace_id: workspaceId, name: 'Scout' }),
      );
    });
  });

  describe('BotRepository.savePinned', () => {
    it("upserts the user's pinned bots for this workspace", async () => {
      await repo.savePinned('user-1', ['b2', 'b1']);

      expect(mockDb.insert).toHaveBeenCalledWith(botOrders);
      expect(mockDb.values).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: 'user-1', workspace_id: workspaceId, bot_ids: ['b2', 'b1'] }),
      );
      const conflict = mockDb.onConflictDoUpdate.mock.calls[0][0] as {
        target: unknown[];
        set: Record<string, unknown>;
      };
      expect(conflict.target).toEqual([botOrders.user_id, botOrders.workspace_id]);
      expect(conflict.set.bot_ids).toEqual(['b2', 'b1']);
    });
  });

  describe('BotRepository.update', () => {
    it('returns null when no live bot matched', async () => {
      mockDb.returning.mockResolvedValueOnce([]);
      await expect(repo.update('missing', { name: 'x' })).resolves.toBeNull();
    });
  });

  describe('BotRepository.archive', () => {
    it('never archives the default bot', async () => {
      mockDb.returning.mockResolvedValueOnce([]);

      await expect(repo.archive('b1')).resolves.toBe(false);

      const where = toQuery(mockDb.where.mock.calls[0][0]);
      expect(where.sql).toContain('"is_default" = $3');
      expect(where.params).toEqual([workspaceId, 'b1', false]);
    });

    it('reports success when a live, non-default bot was archived', async () => {
      mockDb.returning.mockResolvedValueOnce([{ id: 'b1' }]);
      await expect(repo.archive('b1')).resolves.toBe(true);
    });
  });
});
