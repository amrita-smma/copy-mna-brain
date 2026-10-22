import { describe, expect, it } from 'vitest';
import { dayLabel, dayStarts, formatMessageTime, messageCreatedAt, sentNow, startsNewDay } from './messageTime';

// Local-time dates: the transcript shows the viewer's clock.
const at = (y: number, m: number, d: number, h = 9, min = 41) => new Date(y, m - 1, d, h, min);

describe('messageCreatedAt', () => {
  it('reads an ISO stamp from the metadata and ignores anything else', () => {
    expect(messageCreatedAt({ metadata: { createdAt: '2026-10-21T02:41:00.000Z' } })?.toISOString()).toBe(
      '2026-10-21T02:41:00.000Z',
    );
    expect(messageCreatedAt({ metadata: { createdAt: 'yesterday' } })).toBeNull();
    expect(messageCreatedAt({ metadata: { createdAt: 5 } })).toBeNull();
    expect(messageCreatedAt({ metadata: {} })).toBeNull();
    expect(messageCreatedAt({})).toBeNull();
  });
});

describe('sentNow', () => {
  it('stamps the given moment as ISO', () => {
    expect(sentNow(new Date('2026-10-21T02:41:00.000Z'))).toEqual({ createdAt: '2026-10-21T02:41:00.000Z' });
  });
});

describe('formatMessageTime', () => {
  it('prints the 24-hour time of day', () => {
    expect(formatMessageTime(at(2026, 10, 21, 9, 5))).toBe('09:05');
    expect(formatMessageTime(at(2026, 10, 21, 17, 30))).toBe('17:30');
  });
});

describe('dayLabel', () => {
  const now = at(2026, 10, 21, 15);

  it('says Today and Yesterday for those days', () => {
    expect(dayLabel(at(2026, 10, 21, 0, 1), now)).toBe('Today');
    expect(dayLabel(at(2026, 10, 20, 23, 59), now)).toBe('Yesterday');
  });

  it('names the weekday within the last week, then the date, with the year once it differs', () => {
    expect(dayLabel(at(2026, 10, 19), now)).toBe('Monday');
    expect(dayLabel(at(2026, 10, 15), now)).toBe('Thursday');
    expect(dayLabel(at(2026, 10, 14), now)).toBe('Wed, 14 Oct');
    expect(dayLabel(at(2025, 12, 31), now)).toBe('Wed, 31 Dec 2025');
  });

  it('uses the real clock when no now is given', () => {
    expect(dayLabel(new Date())).toBe('Today');
  });
});

describe('startsNewDay', () => {
  it('is true for the first dated message and whenever the calendar day changes', () => {
    expect(startsNewDay(null, at(2026, 10, 21))).toBe(true);
    expect(startsNewDay(at(2026, 10, 20, 23, 59), at(2026, 10, 21, 0, 0))).toBe(true);
    expect(startsNewDay(at(2026, 10, 21, 8), at(2026, 10, 21, 22))).toBe(false);
  });
});

describe('dayStarts', () => {
  it('marks the first dated row and each row that opens a new day, reading through undated rows and groups', () => {
    const rows: (Date | null)[][] = [
      [null],
      [at(2026, 10, 20, 9)],
      [at(2026, 10, 20, 10), at(2026, 10, 21, 1)],
      [null],
      [at(2026, 10, 21, 8)],
      [at(2026, 10, 22, 8)],
    ];
    expect(dayStarts(rows, (r) => r)).toEqual([null, at(2026, 10, 20, 9), null, null, null, at(2026, 10, 22, 8)]);
  });
});
