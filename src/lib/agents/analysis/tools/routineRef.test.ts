import { describe, expect, it } from 'vitest';
import type { BotRoutineDto } from '@/lib/bots/routineTypes';
import { BotRoutineValidationError } from '@/lib/services/botRoutineService';
import { describeRoutine, hasScheduleChange, resolveRoutineRef, schedulePatch } from './routineRef';

function routine(over: Partial<BotRoutineDto> = {}): BotRoutineDto {
  return {
    id: 'r1',
    bot_id: 'copilot',
    title: 'Morning pipeline',
    prompt: 'Summarise my pipeline.',
    schedule_kind: 'weekly',
    schedule_spec: { time: '09:00', weekdays: [1, 2, 3, 4, 5] },
    timezone: 'Asia/Jakarta',
    schedule_label: 'Weekdays at 09:00 (Asia/Jakarta)',
    enabled: true,
    next_fire_at: '2026-10-22T02:00:00.000Z',
    last_fired_at: null,
    created_by: 'u1',
    created_by_name: null,
    is_mine: true,
    created_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}

describe('resolveRoutineRef', () => {
  const routines = [
    routine(),
    routine({ id: 'r2', title: 'Evening pipeline' }),
    routine({ id: 'r3', title: 'Weekly CRM digest' }),
  ];

  it('finds a routine by id, by exact title in any case, and by a phrase only one title contains', () => {
    expect(resolveRoutineRef(routines, 'r2')?.id).toBe('r2');
    expect(resolveRoutineRef(routines, 'MORNING PIPELINE')?.id).toBe('r1');
    expect(resolveRoutineRef(routines, 'crm')?.id).toBe('r3');
  });

  it('returns null for a phrase that matches several routines, or nothing', () => {
    expect(resolveRoutineRef(routines, 'pipeline')).toBeNull();
    expect(resolveRoutineRef(routines, 'nothing like this')).toBeNull();
    expect(resolveRoutineRef(routines, '  ')).toBeNull();
  });

  it('prefers the exact title over a longer title that contains it', () => {
    const list = [routine({ id: 'a', title: 'Digest' }), routine({ id: 'b', title: 'Digest extended' })];
    expect(resolveRoutineRef(list, 'digest')?.id).toBe('a');
  });
});

describe('describeRoutine', () => {
  it('prints the title, the schedule in words, the next run or paused, and the id', () => {
    expect(describeRoutine(routine())).toBe(
      'Morning pipeline — Weekdays at 09:00 (Asia/Jakarta), next run 2026-10-22T02:00:00.000Z (id r1)',
    );
    expect(describeRoutine(routine({ enabled: false, next_fire_at: null }))).toBe(
      'Morning pipeline — Weekdays at 09:00 (Asia/Jakarta), paused (id r1)',
    );
  });
});

describe('hasScheduleChange', () => {
  it('is true when any schedule field was given, false otherwise', () => {
    expect(hasScheduleChange({})).toBe(false);
    expect(hasScheduleChange({ time: '10:00' })).toBe(true);
    expect(hasScheduleChange({ timezone: 'UTC' })).toBe(true);
    expect(hasScheduleChange({ schedule: 'daily' })).toBe(true);
  });
});

describe('schedulePatch', () => {
  it('keeps the kind, the other details and the timezone when only the time changes', () => {
    expect(schedulePatch(routine(), { time: '10:00' })).toEqual({
      schedule_kind: 'weekly',
      schedule_spec: { time: '10:00', weekdays: [1, 2, 3, 4, 5] },
      timezone: 'Asia/Jakarta',
    });
  });

  it('changes only the timezone when only that is given', () => {
    expect(schedulePatch(routine(), { timezone: 'Europe/London' })).toEqual({
      schedule_kind: 'weekly',
      schedule_spec: { time: '09:00', weekdays: [1, 2, 3, 4, 5] },
      timezone: 'Europe/London',
    });
  });

  it('carries the time of day over when switching between daily, weekly and monthly', () => {
    expect(schedulePatch(routine(), { schedule: 'monthly', day_of_month: 1 })).toEqual({
      schedule_kind: 'monthly',
      schedule_spec: { time: '09:00', day: 1 },
      timezone: 'Asia/Jakarta',
    });
    expect(schedulePatch(routine({ schedule_kind: 'daily', schedule_spec: { time: '08:30' } }), { schedule: 'weekly', weekdays: [1] })).toEqual({
      schedule_kind: 'weekly',
      schedule_spec: { time: '08:30', weekdays: [1] },
      timezone: 'Asia/Jakarta',
    });
  });

  it('starts from nothing when switching to or from cron', () => {
    expect(schedulePatch(routine(), { schedule: 'cron', cron: '0 9 * * 1' })).toEqual({
      schedule_kind: 'cron',
      schedule_spec: { expression: '0 9 * * 1' },
      timezone: 'Asia/Jakarta',
    });
    expect(
      schedulePatch(routine({ schedule_kind: 'cron', schedule_spec: { expression: '0 9 * * 1' } }), { schedule: 'daily', time: '07:00' }),
    ).toEqual({ schedule_kind: 'daily', schedule_spec: { time: '07:00' }, timezone: 'Asia/Jakarta' });
  });

  it('switches to cron when a cron expression comes without a kind, instead of dropping it', () => {
    expect(schedulePatch(routine(), { cron: '0 9 * * 1' })).toEqual({
      schedule_kind: 'cron',
      schedule_spec: { expression: '0 9 * * 1' },
      timezone: 'Asia/Jakarta',
    });
  });

  it('refuses a detail the resulting kind would silently ignore', () => {
    const cronRoutine = routine({ schedule_kind: 'cron', schedule_spec: { expression: '0 9 * * 1' } });
    expect(() => schedulePatch(cronRoutine, { time: '10:00' })).toThrow(BotRoutineValidationError);
    expect(() => schedulePatch(cronRoutine, { time: '10:00' })).toThrow('time does not apply to a cron routine');
    expect(() => schedulePatch(routine(), { day_of_month: 3 })).toThrow('day_of_month does not apply to a weekly routine');
    expect(() => schedulePatch(routine({ schedule_kind: 'daily', schedule_spec: { time: '08:30' } }), { weekdays: [1] })).toThrow(
      'weekdays does not apply to a daily routine',
    );
    expect(() => schedulePatch(routine(), { schedule: 'daily', weekdays: [1] })).toThrow('weekdays does not apply to a daily routine');
    expect(() => schedulePatch(cronRoutine, { schedule: 'daily', time: '10:00' })).not.toThrow();
  });

  it('leaves a weekly switch without weekdays to the service to refuse', () => {
    expect(schedulePatch(routine({ schedule_kind: 'daily', schedule_spec: { time: '08:30' } }), { schedule: 'weekly' }).schedule_spec).toEqual({
      time: '08:30',
    });
  });
});
