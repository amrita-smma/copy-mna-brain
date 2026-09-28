import { describe, it, expect } from 'vitest';
import {
  MAX_DEADLINE_LEAD_MS,
  MIN_DEADLINE_LEAD_MS,
  combineDeadline,
  defaultDeadline,
  describeTimeRemaining,
  isDeadlineDay,
  isDeadlineTime,
  parseDeadline,
  toDeadlineDay,
  toDeadlineTime,
} from './deadline';

const NOW = new Date('2026-09-28T09:00:00.000Z');

describe('parseDeadline', () => {
  it('returns the instant the client picked', () => {
    const deadline = parseDeadline('2026-09-30T17:30:00.000Z', NOW);
    expect(deadline.toISOString()).toBe('2026-09-30T17:30:00.000Z');
  });

  it('rejects a missing or blank value', () => {
    expect(() => parseDeadline(undefined, NOW)).toThrow(/Pick a date and time/);
    expect(() => parseDeadline('   ', NOW)).toThrow(/Pick a date and time/);
  });

  it('rejects a non-string value', () => {
    expect(() => parseDeadline(1759050000000, NOW)).toThrow(/Pick a date and time/);
  });

  it('rejects an unparseable date', () => {
    expect(() => parseDeadline('next tuesday-ish', NOW)).toThrow(/not a valid date/);
  });

  it('rejects a deadline in the past', () => {
    expect(() => parseDeadline('2026-09-27T09:00:00.000Z', NOW)).toThrow(
      /at least 15 minutes/,
    );
  });

  it('rejects a deadline inside the minimum lead time', () => {
    const tooSoon = new Date(NOW.getTime() + MIN_DEADLINE_LEAD_MS - 1000);
    expect(() => parseDeadline(tooSoon.toISOString(), NOW)).toThrow(
      /at least 15 minutes/,
    );
  });

  it('accepts a deadline exactly at the minimum lead time', () => {
    const edge = new Date(NOW.getTime() + MIN_DEADLINE_LEAD_MS);
    expect(parseDeadline(edge.toISOString(), NOW).toISOString()).toBe(edge.toISOString());
  });

  it('rejects a deadline more than a year out', () => {
    const tooFar = new Date(NOW.getTime() + MAX_DEADLINE_LEAD_MS + 1000);
    expect(() => parseDeadline(tooFar.toISOString(), NOW)).toThrow(/within a year/);
  });
});

describe('combineDeadline', () => {
  it('combines the picker fields into a local instant', () => {
    const combined = combineDeadline('2026-09-30', '17:30');
    expect(combined).not.toBeNull();
    expect(combined!.getFullYear()).toBe(2026);
    expect(combined!.getMonth()).toBe(8);
    expect(combined!.getDate()).toBe(30);
    expect(combined!.getHours()).toBe(17);
    expect(combined!.getMinutes()).toBe(30);
    expect(combined!.getSeconds()).toBe(0);
  });

  it('returns null for a malformed day or time', () => {
    expect(combineDeadline('30-09-2026', '17:30')).toBeNull();
    expect(combineDeadline('2026-09-30', '5pm')).toBeNull();
    expect(combineDeadline('', '')).toBeNull();
  });

  it('returns null for an out-of-range time instead of rolling over', () => {
    expect(combineDeadline('2026-09-30', '25:00')).toBeNull();
    expect(combineDeadline('2026-09-30', '12:99')).toBeNull();
  });

  it('returns null for a day that does not exist', () => {
    expect(combineDeadline('2026-02-31', '12:00')).toBeNull();
    expect(combineDeadline('2026-13-01', '12:00')).toBeNull();
  });

  it('round-trips through the field formatters', () => {
    const combined = combineDeadline('2026-01-05', '08:05')!;
    expect(toDeadlineDay(combined)).toBe('2026-01-05');
    expect(toDeadlineTime(combined)).toBe('08:05');
  });
});

describe('defaultDeadline', () => {
  it('opens two days out, snapped to the next whole hour', () => {
    const local = new Date(2026, 8, 28, 9, 17, 42);
    const { day, time } = defaultDeadline(local);
    expect(day).toBe('2026-09-30');
    expect(time).toBe('10:00');
  });

  it('produces fields the picker can combine back into a future instant', () => {
    const local = new Date(2026, 8, 28, 9, 17, 42);
    const { day, time } = defaultDeadline(local);
    const combined = combineDeadline(day, time);
    expect(combined).not.toBeNull();
    expect(combined!.getTime() - local.getTime()).toBeGreaterThan(MIN_DEADLINE_LEAD_MS);
  });
});

describe('describeTimeRemaining', () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms);

  it('renders days and hours together', () => {
    expect(describeTimeRemaining(at(52 * 60 * 60 * 1000), NOW)).toBe('2 days 4 hours');
  });

  it('singularizes a one-day / one-hour remainder', () => {
    expect(describeTimeRemaining(at(25 * 60 * 60 * 1000), NOW)).toBe('1 day 1 hour');
  });

  it('drops minutes once there is a day left', () => {
    expect(describeTimeRemaining(at(48 * 60 * 60 * 1000 + 30 * 60_000), NOW)).toBe(
      '2 days',
    );
  });

  it('reports minutes for a same-day deadline', () => {
    expect(describeTimeRemaining(at(35 * 60_000), NOW)).toBe('35 minutes');
    expect(describeTimeRemaining(at(90 * 60_000), NOW)).toBe('1 hour 30 minutes');
  });

  it('reports a sub-minute remainder rather than an empty string', () => {
    expect(describeTimeRemaining(at(30_000), NOW)).toBe('less than a minute');
  });

  it('reports a passed deadline as past due', () => {
    expect(describeTimeRemaining(at(-1000), NOW)).toBe('past due');
    expect(describeTimeRemaining(NOW, NOW)).toBe('past due');
  });
});

describe('isDeadlineDay / isDeadlineTime', () => {
  it('accepts the picker formats', () => {
    expect(isDeadlineDay('2026-09-30')).toBe(true);
    expect(isDeadlineTime('07:05')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isDeadlineDay('2026-9-30')).toBe(false);
    expect(isDeadlineDay(20260930)).toBe(false);
    expect(isDeadlineTime('7:05')).toBe(false);
    expect(isDeadlineTime(null)).toBe(false);
  });
});
