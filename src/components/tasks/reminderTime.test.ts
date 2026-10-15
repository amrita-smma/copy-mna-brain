import { describe, it, expect } from 'vitest';
import { formatReminder, reminderPresets, toDateTimeLocal } from './reminderTime';
import { isTaskOverdue } from '@/hooks/useUserTasks';

describe('reminderPresets', () => {
  it('offers later today, tomorrow and next week in the morning', () => {
    const now = new Date(2026, 9, 15, 10, 30); // Thu 15 Oct 10:30 local
    const presets = reminderPresets(now);

    expect(presets.map((p) => p.label)).toEqual(['Later today', 'Tomorrow', 'Next week']);
    expect(presets[0]!.at).toEqual(new Date(2026, 9, 15, 14, 0));
    expect(presets[1]!.at).toEqual(new Date(2026, 9, 16, 9, 0));
    expect(presets[2]!.at).toEqual(new Date(2026, 9, 19, 9, 0));
  });

  it('drops "Later today" late in the evening', () => {
    const presets = reminderPresets(new Date(2026, 9, 15, 21, 0));

    expect(presets.map((p) => p.label)).toEqual(['Tomorrow', 'Next week']);
  });
});

describe('formatReminder', () => {
  it('formats a far-off reminder with its date', () => {
    const now = new Date(2026, 0, 1, 12, 0);
    expect(formatReminder(new Date(2027, 2, 4, 9, 5).toISOString(), now)).toBe('4 Mar 2027 09:05');
  });

  it('returns an empty string for an invalid date', () => {
    expect(formatReminder('nope')).toBe('');
  });
});

describe('toDateTimeLocal', () => {
  it('produces the datetime-local input format in local time', () => {
    expect(toDateTimeLocal(new Date(2026, 9, 15, 8, 7))).toBe('2026-10-15T08:07');
  });
});

describe('isTaskOverdue', () => {
  const base = { id: 't', title: 'x', createdAt: '2026-10-01T00:00:00Z' };
  const now = new Date('2026-10-15T10:00:00Z').getTime();

  it('is true only for open tasks whose reminder has passed', () => {
    expect(isTaskOverdue({ ...base, remindAt: '2026-10-15T09:00:00Z', completedAt: null }, now)).toBe(true);
    expect(isTaskOverdue({ ...base, remindAt: '2026-10-15T11:00:00Z', completedAt: null }, now)).toBe(false);
    expect(isTaskOverdue({ ...base, remindAt: null, completedAt: null }, now)).toBe(false);
    expect(
      isTaskOverdue({ ...base, remindAt: '2026-10-15T09:00:00Z', completedAt: '2026-10-15T09:30:00Z' }, now),
    ).toBe(false);
  });
});
