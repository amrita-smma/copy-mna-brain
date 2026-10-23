import { describe, it, expect } from 'vitest';
import { lastContactAfter, lastContactBefore } from './lastContactRange';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('lastContactAfter', () => {
  it('returns undefined without a preset and for stale_30', () => {
    expect(lastContactAfter(null, null, null, NOW)).toBeUndefined();
    expect(lastContactAfter('stale_30', null, null, NOW)).toBeUndefined();
    expect(lastContactAfter('bogus', null, null, NOW)).toBeUndefined();
  });

  it('starts today / yesterday at the client midnight when given', () => {
    const midnight = '2026-10-16T17:00:00.000Z';
    expect(lastContactAfter('today', null, midnight, NOW)).toBe(midnight);
    expect(lastContactAfter('yesterday', null, midnight, NOW)).toBe(
      new Date(Date.parse(midnight) - DAY).toISOString(),
    );
  });

  it('uses rolling 7 / 30 day windows for week and month', () => {
    expect(lastContactAfter('week', null, null, NOW)).toBe(new Date(NOW - 7 * DAY).toISOString());
    expect(lastContactAfter('month', null, null, NOW)).toBe(new Date(NOW - 30 * DAY).toISOString());
  });

  it('reads a custom date and ignores an unparseable one', () => {
    expect(lastContactAfter('custom', '2026-09-01', null, NOW)).toBe('2026-09-01T00:00:00.000Z');
    expect(lastContactAfter('custom', 'nope', null, NOW)).toBeUndefined();
    expect(lastContactAfter('custom', null, null, NOW)).toBeUndefined();
  });
});

describe('lastContactBefore', () => {
  it('is 30 days ago only for stale_30', () => {
    expect(lastContactBefore('stale_30', NOW)).toBe(new Date(NOW - 30 * DAY).toISOString());
    expect(lastContactBefore('month', NOW)).toBeUndefined();
    expect(lastContactBefore(null, NOW)).toBeUndefined();
  });
});
