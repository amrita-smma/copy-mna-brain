import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  BotRoutineNotFoundError,
  BotRoutineService,
  BotRoutineValidationError,
} from './botRoutineService';
import { BotForbiddenError, BotNotFoundError } from './botService';

const repo = vi.hoisted(() => ({
  listForBot: vi.fn(),
  findForBot: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  pause: vi.fn(),
  advanceIfDue: vi.fn(),
  revertFireAdvance: vi.fn(),
}));
const botService = vi.hoisted(() => ({ findVisibleRow: vi.fn(), assertCanEdit: vi.fn() }));
const isMember = vi.hoisted(() => vi.fn());
const dispatchBotMessage = vi.hoisted(() => vi.fn());

const bot = { id: 'bot-1', name: 'Scout', visibility: 'workspace', owner_user_id: 'owner', is_default: false };

function routineRow(over: Record<string, unknown> = {}) {
  return {
    id: 'rt-1',
    bot_id: 'bot-1',
    title: 'Morning pipeline',
    prompt: 'Summarise my pipeline',
    schedule_kind: 'weekly',
    schedule_spec: { time: '09:00', weekdays: [1, 2, 3, 4, 5] },
    cron_expression: '0 9 * * 1,2,3,4,5',
    timezone: 'UTC',
    enabled: true,
    next_fire_at: '2026-10-16T09:00:00.000Z',
    last_fired_at: null,
    created_by: 'ana',
    created_by_name: 'Ana',
    created_at: '2026-10-15T00:00:00Z',
    workspace_id: 'ws-1',
    ...over,
  };
}

const input = {
  title: ' Morning pipeline ',
  prompt: 'Summarise my pipeline',
  schedule_kind: 'weekly',
  schedule_spec: { time: '09:00', weekdays: [1, 2, 3, 4, 5] },
  timezone: 'Asia/Jakarta',
};

describe('BotRoutineService', () => {
  let service: BotRoutineService;

  beforeEach(() => {
    for (const fn of [...Object.values(repo), ...Object.values(botService), isMember, dispatchBotMessage]) {
      fn.mockReset();
    }
    botService.findVisibleRow.mockResolvedValue(bot);
    isMember.mockResolvedValue(true);
    dispatchBotMessage.mockResolvedValue({ jobId: 'j' });
    service = new BotRoutineService({
      routinesRepo: repo as never,
      botService: botService as never,
      isMember,
      dispatchBotMessage,
    });
  });

  describe('BotRoutineService.list', () => {
    it("lists a visible bot's routines with their schedule in words and whose they are", async () => {
      repo.listForBot.mockResolvedValue([routineRow()]);

      const [dto] = await service.list('ana', 'bot-1');

      expect(botService.findVisibleRow).toHaveBeenCalledWith('ana', 'bot-1');
      expect(dto).toMatchObject({
        id: 'rt-1',
        schedule_label: 'Weekdays at 09:00 (UTC)',
        created_by_name: 'Ana',
        is_mine: true,
      });
      expect((await service.list('ben', 'bot-1'))[0].is_mine).toBe(false);
    });

    it("hides the routines of a bot the user cannot see", async () => {
      botService.findVisibleRow.mockRejectedValue(new BotNotFoundError());
      await expect(service.list('ben', 'bot-1')).rejects.toBeInstanceOf(BotNotFoundError);
      expect(repo.listForBot).not.toHaveBeenCalled();
    });
  });

  describe('BotRoutineService.create', () => {
    it('stores the routine on the bot, created by the user, with its first fire computed', async () => {
      repo.create.mockImplementation(async (row) => ({ id: 'rt-9', created_at: 'now', ...row }));

      const dto = await service.create('ana', 'bot-1', input);

      const [row] = repo.create.mock.calls[0];
      expect(row).toMatchObject({
        bot_id: 'bot-1',
        title: 'Morning pipeline',
        cron_expression: '0 9 * * 1,2,3,4,5',
        timezone: 'Asia/Jakarta',
        created_by: 'ana',
        enabled: true,
        agent_name: null,
      });
      expect(new Date(row.next_fire_at).getTime()).toBeGreaterThan(Date.now());
      expect(dto.is_mine).toBe(true);
    });

    it('needs permission to edit the bot', async () => {
      botService.assertCanEdit.mockImplementation(() => {
        throw new BotForbiddenError();
      });
      await expect(service.create('ben', 'bot-1', input)).rejects.toBeInstanceOf(BotForbiddenError);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('rejects a missing title or message, and a schedule that does not parse', async () => {
      await expect(service.create('ana', 'bot-1', { ...input, title: ' ' })).rejects.toBeInstanceOf(
        BotRoutineValidationError,
      );
      await expect(service.create('ana', 'bot-1', { ...input, prompt: '' })).rejects.toBeInstanceOf(
        BotRoutineValidationError,
      );
      await expect(
        service.create('ana', 'bot-1', { ...input, schedule_spec: { time: '25:00', weekdays: [1] } }),
      ).rejects.toBeInstanceOf(BotRoutineValidationError);
      await expect(service.create('ana', 'bot-1', { ...input, schedule_kind: 'hourly' })).rejects.toBeInstanceOf(
        BotRoutineValidationError,
      );
      await expect(service.create('ana', 'bot-1', { ...input, timezone: 'Mars/Base' })).rejects.toBeInstanceOf(
        BotRoutineValidationError,
      );
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('BotRoutineService.update', () => {
    it('renames without touching the schedule', async () => {
      repo.findForBot.mockResolvedValue(routineRow());
      repo.update.mockImplementation(async (_id, patch) => routineRow(patch));

      await service.update('ben', 'bot-1', 'rt-1', { title: 'Evening pipeline' });

      expect(repo.update).toHaveBeenCalledWith('rt-1', { updated_by: 'ben', title: 'Evening pipeline' });
    });

    it('recomputes the next fire when switching a paused routine back on', async () => {
      repo.findForBot.mockResolvedValue(routineRow({ enabled: false, next_fire_at: '2020-01-01T00:00:00Z' }));
      repo.update.mockImplementation(async (_id, patch) => routineRow(patch));

      await service.update('ben', 'bot-1', 'rt-1', { enabled: true });

      const [, patch] = repo.update.mock.calls[0];
      expect(patch.enabled).toBe(true);
      expect(new Date(patch.next_fire_at).getTime()).toBeGreaterThan(Date.now());
    });

    it("404s a routine that is not this bot's", async () => {
      repo.findForBot.mockResolvedValue(null);
      await expect(service.update('ana', 'bot-1', 'rt-x', { title: 'x' })).rejects.toBeInstanceOf(
        BotRoutineNotFoundError,
      );
    });
  });

  describe('BotRoutineService.runNow', () => {
    it("sends the routine's message now, as the user asking, without moving the schedule", async () => {
      repo.findForBot.mockResolvedValue(routineRow());

      await service.runNow('ben', 'bot-1', 'rt-1');

      expect(dispatchBotMessage).toHaveBeenCalledWith({
        userId: 'ben',
        origin: { kind: 'routine', routine: { id: 'rt-1', title: 'Morning pipeline' } },
        toBotId: 'bot-1',
        text: 'Summarise my pipeline',
      });
      expect(repo.advanceIfDue).not.toHaveBeenCalled();
    });
  });

  describe('BotRoutineService on Brain Bot', () => {
    const brain = { id: 'brain', name: 'Brain Bot', visibility: 'workspace', owner_user_id: null, is_default: true };

    beforeEach(() => {
      botService.findVisibleRow.mockResolvedValue(brain);
    });

    it("lists only the user's own routines on it", async () => {
      repo.listForBot.mockResolvedValue([]);
      await service.list('ana', 'brain');
      expect(repo.listForBot).toHaveBeenCalledWith('brain', { createdBy: 'ana' });
    });

    it('lets anyone add a routine to it, though nobody may edit the bot itself', async () => {
      repo.create.mockImplementation(async (r) => ({ ...routineRow(), ...r }));
      await service.create('ana', 'brain', input);
      expect(botService.assertCanEdit).not.toHaveBeenCalled();
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ bot_id: 'brain', created_by: 'ana' }));
    });

    it("finds only the user's own routine to change, delete or run", async () => {
      repo.findForBot.mockResolvedValue(null);
      await expect(service.update('ben', 'brain', 'rt-1', { title: 'Mine now' })).rejects.toBeInstanceOf(
        BotRoutineNotFoundError,
      );
      await expect(service.archive('ben', 'brain', 'rt-1')).rejects.toBeInstanceOf(BotRoutineNotFoundError);
      await expect(service.runNow('ben', 'brain', 'rt-1')).rejects.toBeInstanceOf(BotRoutineNotFoundError);
      for (const call of repo.findForBot.mock.calls) expect(call).toEqual(['brain', 'rt-1', { createdBy: 'ben' }]);
      expect(repo.update).not.toHaveBeenCalled();
      expect(repo.archive).not.toHaveBeenCalled();
      expect(dispatchBotMessage).not.toHaveBeenCalled();
    });
  });

  describe('BotRoutineService.fire', () => {
    const now = new Date('2026-10-16T09:00:20Z');

    it('advances the schedule, then sends the prompt to the bot as its creator', async () => {
      repo.advanceIfDue.mockResolvedValue(true);

      expect(await service.fire(routineRow() as never, now)).toEqual({ status: 'fired' });

      expect(botService.findVisibleRow).toHaveBeenCalledWith('ana', 'bot-1');
      const [id, dueAt, firedAt, next] = repo.advanceIfDue.mock.calls[0];
      expect([id, dueAt, firedAt]).toEqual(['rt-1', '2026-10-16T09:00:00.000Z', now]);
      expect(next).toBe('2026-10-19T09:00:00.000Z');
      expect(dispatchBotMessage).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'ana', toBotId: 'bot-1', text: 'Summarise my pipeline' }),
      );
    });

    it('sends nothing when another tick already fired it', async () => {
      repo.advanceIfDue.mockResolvedValue(false);
      expect(await service.fire(routineRow() as never, now)).toMatchObject({ status: 'skipped' });
      expect(dispatchBotMessage).not.toHaveBeenCalled();
    });

    it('rolls the schedule back when the job cannot be queued', async () => {
      repo.advanceIfDue.mockResolvedValue(true);
      dispatchBotMessage.mockRejectedValueOnce(new Error('queue down'));

      await expect(service.fire(routineRow() as never, now)).rejects.toThrow('queue down');

      expect(repo.revertFireAdvance).toHaveBeenCalledWith(
        'rt-1',
        '2026-10-19T09:00:00.000Z',
        '2026-10-16T09:00:00.000Z',
        null,
      );
    });

    it('pauses instead of running as someone who lost the bot or left the workspace', async () => {
      botService.findVisibleRow.mockRejectedValueOnce(new BotNotFoundError());
      expect(await service.fire(routineRow() as never, now)).toMatchObject({ status: 'paused' });

      isMember.mockResolvedValueOnce(false);
      expect(await service.fire(routineRow() as never, now)).toMatchObject({ status: 'paused' });

      expect(await service.fire(routineRow({ created_by: null }) as never, now)).toMatchObject({ status: 'paused' });

      expect(repo.pause).toHaveBeenCalledTimes(3);
      expect(repo.advanceIfDue).not.toHaveBeenCalled();
      expect(dispatchBotMessage).not.toHaveBeenCalled();
    });
  });
});

describe('BotRoutineService.validateInput', () => {
  beforeEach(() => {
    repo.create.mockReset();
    botService.findVisibleRow.mockReset();
  });
  const service = () =>
    new BotRoutineService({
      routinesRepo: repo as never,
      botService: botService as never,
      isMember,
      dispatchBotMessage,
    });

  it('validates a routine for a bot that does not exist yet and describes its schedule, touching nothing', () => {
    const out = service().validateInput({
      title: '  Morning pipeline ',
      prompt: 'Summarise the pipeline.',
      schedule_kind: 'daily',
      schedule_spec: { time: '08:00' },
      timezone: 'UTC',
    });

    expect(out.routine).toEqual({
      title: 'Morning pipeline',
      prompt: 'Summarise the pipeline.',
      schedule_kind: 'daily',
      schedule_spec: expect.objectContaining({ time: '08:00' }),
      timezone: 'UTC',
    });
    expect(out.label).toMatch(/08:00/);
    expect(repo.create).not.toHaveBeenCalled();
    expect(botService.findVisibleRow).not.toHaveBeenCalled();
  });

  it('rejects a bad schedule or a missing title the same way create does', () => {
    expect(() => service().validateInput({ title: '', prompt: 'p', schedule_kind: 'daily', schedule_spec: { time: '08:00' }, timezone: 'UTC' })).toThrow(
      /Title is required/,
    );
    expect(() => service().validateInput({ title: 't', prompt: 'p', schedule_kind: 'hourly', schedule_spec: {}, timezone: 'UTC' })).toThrow(
      /daily, weekly, monthly or cron/,
    );
  });
});
