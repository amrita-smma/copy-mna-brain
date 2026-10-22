import { describe, it, expect } from 'vitest';
import { describeSchedule } from './describe';

describe('describeSchedule', () => {
  it('names each kind of schedule in words', () => {
    expect(describeSchedule('daily', { time: '09:00' }, 'Asia/Jakarta')).toBe('Every day at 09:00 (Asia/Jakarta)');
    expect(describeSchedule('weekly', { time: '08:30', weekdays: [5, 1, 2, 3, 4] })).toBe('Weekdays at 08:30');
    expect(describeSchedule('weekly', { time: '10:00', weekdays: [0, 6] })).toBe('Weekends at 10:00');
    expect(describeSchedule('weekly', { time: '10:00', weekdays: [1, 3] })).toBe('Every Mon, Wed at 10:00');
    expect(describeSchedule('monthly', { time: '07:00', day: 1 })).toBe('Monthly on the 1st at 07:00');
    expect(describeSchedule('monthly', { time: '07:00', day: 12 })).toBe('Monthly on the 12th at 07:00');
    expect(describeSchedule('monthly', { time: '07:00', day: 22 })).toBe('Monthly on the 22nd at 07:00');
    expect(describeSchedule('cron', { expression: '0 9 * * 1' })).toBe('Cron 0 9 * * 1');
  });
});
