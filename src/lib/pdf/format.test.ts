import { describe, it, expect } from 'vitest';
import {
  formatCompact,
  formatPercent,
  niceNumber,
  buildTicks,
  truncateLabel,
} from './format';

describe('formatCompact', () => {
  it('scales thousands, millions, billions and trillions to a short suffix', () => {
    expect(formatCompact(15894)).toBe('15.9k');
    expect(formatCompact(-10279)).toBe('-10.3k');
    expect(formatCompact(1_200_000)).toBe('1.2M');
    expect(formatCompact(-1.2e9)).toBe('-1.2B');
    expect(formatCompact(3.4e12)).toBe('3.4T');
  });

  it('drops a trailing .0 so a round scaled value stays three characters', () => {
    expect(formatCompact(1000)).toBe('1k');
    expect(formatCompact(2_000_000)).toBe('2M');
  });

  it('keeps values under a thousand exact', () => {
    expect(formatCompact(575)).toBe('575');
    expect(formatCompact(0)).toBe('0');
    expect(formatCompact(5.5)).toBe('5.5');
    expect(formatCompact(5.125, 2)).toBe('5.13');
  });

  it('returns an em dash for non-finite input rather than "NaN"', () => {
    expect(formatCompact(Number.NaN)).toBe('—');
    expect(formatCompact(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('appends a percent sign without rescaling the value', () => {
    expect(formatPercent(31)).toBe('31%');
    expect(formatPercent(13.94, 1)).toBe('13.9%');
    expect(formatPercent(0)).toBe('0%');
  });

  it('returns an em dash for non-finite input', () => {
    expect(formatPercent(Number.NaN)).toBe('—');
  });
});

describe('niceNumber', () => {
  it('rounds a span to 1/2/5/10 times a power of ten', () => {
    expect(niceNumber(1, false)).toBe(1);
    expect(niceNumber(1.8, true)).toBe(2);
    expect(niceNumber(6.5, true)).toBe(5);
    expect(niceNumber(8, true)).toBe(10);
    expect(niceNumber(4200, true)).toBe(5000);
  });

  it('falls back to 1 for a zero or non-finite span', () => {
    expect(niceNumber(0, true)).toBe(1);
    expect(niceNumber(-5, true)).toBe(1);
    expect(niceNumber(Number.NaN, true)).toBe(1);
  });
});

describe('buildTicks', () => {
  it('always includes zero so bar heights stay proportional', () => {
    const ticks = buildTicks([15894, 18322, 20757]);
    expect(ticks.min).toBe(0);
    expect(ticks.values[0]).toBe(0);
    expect(ticks.max).toBeGreaterThanOrEqual(20757);
  });

  it('extends below zero when the data has negatives', () => {
    const ticks = buildTicks([-10279, 575]);
    expect(ticks.min).toBeLessThanOrEqual(-10279);
    expect(ticks.max).toBeGreaterThanOrEqual(575);
    expect(ticks.values).toContain(0);
  });

  it('produces ticks on round values, free of float drift', () => {
    const ticks = buildTicks([0, 0.3]);
    for (const value of ticks.values) {
      expect(String(value)).not.toMatch(/\d{8,}/);
    }
  });

  it('returns a unit domain when every value is identical', () => {
    expect(buildTicks([0, 0, 0])).toEqual({
      min: 0,
      max: 1,
      step: 1,
      values: [0, 1],
    });
  });

  it('spaces every tick by exactly one step', () => {
    const ticks = buildTicks([0, 950]);
    for (let i = 1; i < ticks.values.length; i++) {
      expect(ticks.values[i] - ticks.values[i - 1]).toBeCloseTo(ticks.step, 9);
    }
  });
});

describe('truncateLabel', () => {
  it('leaves a label that fits untouched', () => {
    expect(truncateLabel('FY2024', 10)).toBe('FY2024');
  });

  it('ellipsizes a label that overruns its slot', () => {
    expect(truncateLabel('Financial year 2024', 10)).toBe('Financial…');
  });

  it('does not leave a dangling space before the ellipsis', () => {
    expect(truncateLabel('Sea Limited Holdings', 5)).toBe('Sea…');
  });
});
