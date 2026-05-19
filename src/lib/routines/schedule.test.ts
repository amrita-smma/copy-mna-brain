import { describe, expect, it } from 'vitest';
import { computeNextFireAt, normalizeSchedule } from './schedule';

describe('normalizeSchedule', () => {
  it('produces "M H * * *" for daily', () => {
    const r = normalizeSchedule('daily', { time: '06:00' });
    expect(r.cronExpression).toBe('0 6 * * *');
    expect(r.scheduleSpec).toEqual({ time: '06:00' });
  });

  it('handles HH:MM with leading zero', () => {
    const r = normalizeSchedule('daily', { time: '09:30' });
    expect(r.cronExpression).toBe('30 9 * * *');
  });

  it('rejects malformed time', () => {
    expect(() => normalizeSchedule('daily', { time: '24:00' })).toThrow();
    expect(() => normalizeSchedule('daily', { time: '9:5' })).toThrow();
  });

  it('weekly dedupes + sorts weekdays', () => {
    const r = normalizeSchedule('weekly', {
      time: '09:00',
      weekdays: [3, 1, 1, 5],
    });
    expect(r.cronExpression).toBe('0 9 * * 1,3,5');
    expect(r.scheduleSpec).toEqual({ time: '09:00', weekdays: [1, 3, 5] });
  });

  it('weekly rejects empty weekdays', () => {
    expect(() =>
      normalizeSchedule('weekly', { time: '09:00', weekdays: [] }),
    ).toThrow();
  });

  it('weekly rejects out-of-range weekdays', () => {
    expect(() =>
      normalizeSchedule('weekly', { time: '09:00', weekdays: [7] }),
    ).toThrow();
    expect(() =>
      normalizeSchedule('weekly', { time: '09:00', weekdays: [-1] }),
    ).toThrow();
  });

  it('monthly produces "M H D * *"', () => {
    const r = normalizeSchedule('monthly', { time: '00:00', day: 15 });
    expect(r.cronExpression).toBe('0 0 15 * *');
  });

  it('monthly rejects out-of-range day', () => {
    expect(() => normalizeSchedule('monthly', { time: '00:00', day: 0 })).toThrow();
    expect(() => normalizeSchedule('monthly', { time: '00:00', day: 32 })).toThrow();
  });

  it('cron pass-through validates and trims', () => {
    const r = normalizeSchedule('cron', { expression: '  */15 * * * *  ' });
    expect(r.cronExpression).toBe('*/15 * * * *');
    expect(r.scheduleSpec).toEqual({ expression: '*/15 * * * *' });
  });

  it('cron rejects non-5-field expressions', () => {
    expect(() => normalizeSchedule('cron', { expression: '* * * *' })).toThrow();
    expect(() =>
      normalizeSchedule('cron', { expression: '* * * * * *' }),
    ).toThrow();
  });

  it('cron rejects garbage', () => {
    expect(() => normalizeSchedule('cron', { expression: 'not a cron' })).toThrow();
  });
});

describe('computeNextFireAt', () => {
  it('advances strictly forward from the reference instant', () => {
    const ref = new Date('2026-05-18T05:59:00Z');
    const next = computeNextFireAt('0 6 * * *', 'UTC', ref);
    expect(next).toBe('2026-05-18T06:00:00.000Z');
  });

  it('respects timezone offsets', () => {
    // 06:00 ICT = 23:00 UTC the previous day. From a reference at midnight
    // UTC the next ICT-6am is 23:00 UTC of the same day.
    const ref = new Date('2026-05-18T00:00:00Z');
    const next = computeNextFireAt('0 6 * * *', 'Asia/Jakarta', ref);
    expect(next).toBe('2026-05-18T23:00:00.000Z');
  });

  it('skips to next valid day when reference is past today\'s fire', () => {
    const ref = new Date('2026-05-18T07:00:00Z');
    const next = computeNextFireAt('0 6 * * *', 'UTC', ref);
    expect(next).toBe('2026-05-19T06:00:00.000Z');
  });

  it('weekly: picks the next matching weekday', () => {
    // Monday 2026-05-18 at 08:59 UTC; cron fires Mon 09:00.
    const ref = new Date('2026-05-18T08:59:00Z');
    const next = computeNextFireAt('0 9 * * 1', 'UTC', ref);
    expect(next).toBe('2026-05-18T09:00:00.000Z');
  });
});
