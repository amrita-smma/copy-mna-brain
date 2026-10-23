import { describe, it, expect } from 'vitest';
import { INSIGHTS_PERIODS, isInsightsPeriod, periodToSince } from './insightsPeriod';

const NOW = new Date('2026-10-17T12:34:56.789Z');

describe('periodToSince', () => {
  it.each([
    ['all', undefined],
    ['30d', '2026-09-17T12:34:56.789Z'],
    ['90d', '2026-07-19T12:34:56.789Z'],
    ['ytd', '2026-01-01T00:00:00.000Z'],
    ['12m', '2025-10-17T12:34:56.789Z'],
  ] as const)('starts %s at %s', (period, since) => {
    expect(periodToSince(period, NOW)).toBe(since);
  });
});

describe('isInsightsPeriod', () => {
  it('accepts every period and nothing else', () => {
    for (const p of INSIGHTS_PERIODS) expect(isInsightsPeriod(p)).toBe(true);
    expect(isInsightsPeriod('7d')).toBe(false);
    expect(isInsightsPeriod('')).toBe(false);
  });
});
