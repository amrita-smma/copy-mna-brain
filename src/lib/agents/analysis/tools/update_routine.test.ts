import { beforeEach, describe, expect, it, vi } from 'vitest';

const { list, update } = vi.hoisted(() => ({ list: vi.fn(), update: vi.fn() }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services/container', () => ({ createContainer: vi.fn(() => ({ botRoutineService: { list, update } })) }));

import { updateRoutine } from './update_routine';
import { BOT_TOOL_CONFIG } from '@/lib/bots/testing/botFixtures';
import { BotRoutineNotFoundError, BotRoutineValidationError } from '@/lib/services/botRoutineService';
import { BotForbiddenError } from '@/lib/services/botService';

const routines = [
  {
    id: 'r1',
    title: 'Morning pipeline',
    prompt: 'Summarise my pipeline.',
    schedule_kind: 'weekly',
    schedule_spec: { time: '09:00', weekdays: [1, 2, 3, 4, 5] },
    timezone: 'Asia/Jakarta',
    schedule_label: 'Weekdays at 09:00 (Asia/Jakarta)',
    enabled: true,
    next_fire_at: '2026-10-22T02:00:00.000Z',
    is_mine: true,
    created_by_name: null,
  },
  {
    id: 'r2',
    title: 'CRM digest',
    prompt: 'Digest the CRM.',
    schedule_kind: 'daily',
    schedule_spec: { time: '18:00' },
    timezone: 'UTC',
    schedule_label: 'Daily at 18:00 (UTC)',
    enabled: false,
    next_fire_at: null,
    is_mine: false,
    created_by_name: 'Ana',
  },
];

describe('update_routine', () => {
  beforeEach(() => {
    list.mockReset().mockResolvedValue(routines);
    update.mockReset().mockImplementation(async (_u, _b, id, patch) => {
      const r = routines.find((x) => x.id === id)!;
      return {
        ...r,
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled, next_fire_at: patch.enabled ? '2026-10-23T18:00:00.000Z' : null } : {}),
        ...(patch.schedule_spec ? { schedule_label: 'changed' } : {}),
      };
    });
  });

  it('renames a routine by a phrase from its title and sends only the fields given', async () => {
    const out = await updateRoutine.invoke({ routine: 'morning', title: 'Morning deals' }, BOT_TOOL_CONFIG);
    expect(update).toHaveBeenCalledWith('u1', 'copilot', 'r1', { title: 'Morning deals' });
    expect(out).toBe('Updated: Morning deals — Weekdays at 09:00 (Asia/Jakarta), next run 2026-10-22T02:00:00.000Z (id r1).');
  });

  it('rewrites the message as the prompt', async () => {
    await updateRoutine.invoke({ routine: 'r1', message: 'Summarise what moved.' }, BOT_TOOL_CONFIG);
    expect(update).toHaveBeenCalledWith('u1', 'copilot', 'r1', { prompt: 'Summarise what moved.' });
  });

  it('moves the time while keeping the weekdays and timezone', async () => {
    await updateRoutine.invoke({ routine: 'r1', time: '10:00' }, BOT_TOOL_CONFIG);
    expect(update).toHaveBeenCalledWith('u1', 'copilot', 'r1', {
      schedule_kind: 'weekly',
      schedule_spec: { time: '10:00', weekdays: [1, 2, 3, 4, 5] },
      timezone: 'Asia/Jakarta',
    });
  });

  it('switches the kind, keeping the hour, and switches to cron on an expression alone', async () => {
    await updateRoutine.invoke({ routine: 'r1', schedule: 'monthly', day_of_month: 1 }, BOT_TOOL_CONFIG);
    expect(update).toHaveBeenLastCalledWith('u1', 'copilot', 'r1', {
      schedule_kind: 'monthly',
      schedule_spec: { time: '09:00', day: 1 },
      timezone: 'Asia/Jakarta',
    });
    await updateRoutine.invoke({ routine: 'r1', cron: '30 8 * * 1-5', timezone: 'UTC' }, BOT_TOOL_CONFIG);
    expect(update).toHaveBeenLastCalledWith('u1', 'copilot', 'r1', {
      schedule_kind: 'cron',
      schedule_spec: { expression: '30 8 * * 1-5' },
      timezone: 'UTC',
    });
  });

  it('refuses a detail the routine\'s kind would ignore instead of pretending it applied', async () => {
    list.mockResolvedValue([{ ...routines[0], schedule_kind: 'cron', schedule_spec: { expression: '0 9 * * 1' } }]);
    expect(await updateRoutine.invoke({ routine: 'r1', time: '10:00' }, BOT_TOOL_CONFIG)).toBe(
      'Rejection: time does not apply to a cron routine (it takes cron); pass schedule to change the kind',
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('pauses, and resumes a paused routine of someone else with a note that it stays theirs', async () => {
    expect(await updateRoutine.invoke({ routine: 'r1', enabled: false }, BOT_TOOL_CONFIG)).toMatch(/^Paused: Morning pipeline — .*, paused \(id r1\)\.$/);
    expect(update).toHaveBeenLastCalledWith('u1', 'copilot', 'r1', { enabled: false });

    const out = (await updateRoutine.invoke({ routine: 'CRM digest', enabled: true }, BOT_TOOL_CONFIG)) as string;
    expect(update).toHaveBeenLastCalledWith('u1', 'copilot', 'r2', { enabled: true });
    expect(out).toContain('Resumed: CRM digest — Daily at 18:00 (UTC), next run 2026-10-23T18:00:00.000Z (id r2).');
    expect(out).toContain('created by Ana and keeps running as them');
  });

  it('refuses when nothing would change, and when the reference is ambiguous or unknown', async () => {
    expect(await updateRoutine.invoke({ routine: 'r1' }, BOT_TOOL_CONFIG)).toMatch(/^Rejection: pass a new title/);
    list.mockResolvedValue([...routines, { ...routines[0], id: 'r3', title: 'Morning CRM' }]);
    expect(await updateRoutine.invoke({ routine: 'morning', enabled: false }, BOT_TOOL_CONFIG)).toBe(
      'Rejection: no single routine matches "morning". Call list_routines and name one by its id or exact title.',
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('reports a validation error, a vanished routine and a forbidden bot as rejections', async () => {
    update.mockRejectedValueOnce(new BotRoutineValidationError('weekly schedule requires non-empty weekdays array'));
    expect(await updateRoutine.invoke({ routine: 'r2', schedule: 'weekly' }, BOT_TOOL_CONFIG)).toBe(
      'Rejection: weekly schedule requires non-empty weekdays array',
    );
    update.mockRejectedValueOnce(new BotRoutineNotFoundError());
    expect(await updateRoutine.invoke({ routine: 'r1', enabled: false }, BOT_TOOL_CONFIG)).toBe(
      'Rejection: the routine "r1" is gone (deleted meanwhile).',
    );
    update.mockRejectedValueOnce(new BotForbiddenError());
    expect(await updateRoutine.invoke({ routine: 'r1', enabled: false }, BOT_TOOL_CONFIG)).toBe(
      "Rejection: the user cannot change this bot's routines.",
    );
  });

  it('only runs inside a bot chat', async () => {
    expect(await updateRoutine.invoke({ routine: 'r1', enabled: false }, { configurable: { userId: 'u1' } })).toMatch(/^\*\*Error:\*\*/);
    expect(list).not.toHaveBeenCalled();
  });
});
