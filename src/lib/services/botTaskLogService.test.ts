import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BotTaskLogService, BOT_TASK_PAGE_SIZE, type BotTaskEntry } from './botTaskLogService';
import { BotNotFoundError } from './botService';
import { TASK_ANSWER_MAX_CHARS } from '@/lib/bots/taskSummary';

const repo = vi.hoisted(() => ({ insert: vi.fn(), listForUser: vi.fn() }));
const botService = vi.hoisted(() => ({ findVisibleRow: vi.fn() }));
const dispatchSummary = vi.hoisted(() => vi.fn());

const entry: BotTaskEntry = {
  botId: 'b1',
  userId: 'u1',
  chatId: 'c1',
  source: 'routine',
  routine: { id: 'r1', title: 'Daily' },
  question: 'Summarise',
  answer: 'Done.',
  toolNames: ['query_companies'],
};

const ID_A = '11111111-1111-4111-8111-111111111111';

describe('BotTaskLogService', () => {
  let service: BotTaskLogService;

  beforeEach(() => {
    for (const fn of [...Object.values(repo), ...Object.values(botService), dispatchSummary]) fn.mockReset();
    botService.findVisibleRow.mockResolvedValue({ id: 'b1', is_default: false });
    service = new BotTaskLogService({ repo: repo as never, botService: botService as never, dispatchSummary });
  });

  describe('BotTaskLogService.record', () => {
    it('queues the turn for summary with the answer clipped, and skips a turn with no answer', async () => {
      await service.record({ ...entry, answer: 'x'.repeat(TASK_ANSWER_MAX_CHARS + 500) });
      expect(dispatchSummary.mock.calls[0][0].answer).toHaveLength(TASK_ANSWER_MAX_CHARS);

      await service.record({ ...entry, answer: '  ' });
      expect(dispatchSummary).toHaveBeenCalledTimes(1);
    });
  });

  describe('BotTaskLogService.store', () => {
    it('stores the summary with how the task arrived', async () => {
      await service.store(entry, 'Summarised the pipeline');
      expect(repo.insert).toHaveBeenCalledWith({
        bot_id: 'b1',
        user_id: 'u1',
        chat_id: 'c1',
        routine_id: 'r1',
        source: 'routine',
        summary: 'Summarised the pipeline',
      });
    });
  });

  describe('BotTaskLogService.list', () => {
    it("pages a visible bot's log for the user, marking whose each task was", async () => {
      repo.listForUser.mockResolvedValue({
        rows: [
          { id: ID_A, user_id: 'u2', source: 'routine', summary: 's', created_at: '2026-10-15T09:00:00.000Z', routine_id: 'r1', routine_title: 'Daily' },
        ],
        hasMore: true,
      });

      const page = await service.list('u1', 'b1');

      expect(repo.listForUser).toHaveBeenCalledWith('b1', 'u1', { before: undefined, limit: BOT_TASK_PAGE_SIZE, ownOnly: false });
      expect(page.items[0]).toMatchObject({ id: ID_A, is_mine: false, routine_title: 'Daily' });
      expect(page.nextCursor).toBe(`2026-10-15T09:00:00.000Z|${ID_A}`);

      await service.list('u1', 'b1', { before: page.nextCursor!, limit: 500 });
      expect(repo.listForUser).toHaveBeenLastCalledWith('b1', 'u1', {
        before: { createdAt: '2026-10-15T09:00:00.000Z', id: ID_A },
        limit: 100,
        ownOnly: false,
      });
    });

    it("shows only the user's own tasks on Brain Bot, whose routines are each person's own", async () => {
      botService.findVisibleRow.mockResolvedValueOnce({ id: 'brain', is_default: true });
      repo.listForUser.mockResolvedValue({ rows: [], hasMore: false });
      await service.list('u1', 'brain');
      expect(repo.listForUser.mock.calls[0][2]).toMatchObject({ ownOnly: true });
    });

    it('ignores a malformed cursor and hides the log of a bot the user cannot see', async () => {
      repo.listForUser.mockResolvedValue({ rows: [], hasMore: false });
      await service.list('u1', 'b1', { before: 'junk' });
      expect(repo.listForUser.mock.calls[0][2].before).toBeUndefined();

      botService.findVisibleRow.mockRejectedValueOnce(new BotNotFoundError());
      await expect(service.list('u1', 'b1')).rejects.toBeInstanceOf(BotNotFoundError);
    });
  });
});
