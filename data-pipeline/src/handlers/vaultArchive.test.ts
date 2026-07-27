import { describe, expect, it } from 'vitest';
import {
  currentDayUTC,
  dayWindow,
  daysBetween,
  inferCustodianFromEntry,
  parseFloorDay,
  previousDay,
  ymdLessThanOrEqual,
} from './vaultArchive';

describe('daily Vault windows', () => {
  it('parses a valid backfill floor', () => {
    expect(parseFloorDay('2026-07-25')).toEqual({
      year: 2026,
      month: 7,
      day: 25,
    });
  });

  it('rejects malformed and impossible dates', () => {
    expect(() => parseFloorDay('2026/07/25')).toThrow('YYYY-MM-DD');
    expect(() => parseFloorDay('2026-02-30')).toThrow('invalid');
  });

  it('gets the current UTC day', () => {
    expect(currentDayUTC(new Date('2026-07-25T23:59:59Z'))).toEqual({
      year: 2026,
      month: 7,
      day: 25,
    });
  });

  it('walks backward and forward across calendar boundaries', () => {
    expect(previousDay({ year: 2026, month: 1, day: 1 })).toEqual({
      year: 2025,
      month: 12,
      day: 31,
    });
    expect(
      daysBetween(
        { year: 2026, month: 1, day: 31 },
        { year: 2026, month: 2, day: 2 },
      ),
    ).toEqual([
      { year: 2026, month: 1, day: 31 },
      { year: 2026, month: 2, day: 1 },
      { year: 2026, month: 2, day: 2 },
    ]);
  });

  it('returns an empty range when the floor is after the ceiling', () => {
    expect(
      daysBetween(
        { year: 2026, month: 2, day: 2 },
        { year: 2026, month: 2, day: 1 },
      ),
    ).toEqual([]);
  });

  it('compares complete UTC days', () => {
    expect(
      ymdLessThanOrEqual(
        { year: 2026, month: 2, day: 1 },
        { year: 2026, month: 2, day: 1 },
      ),
    ).toBe(true);
    expect(
      ymdLessThanOrEqual(
        { year: 2026, month: 2, day: 2 },
        { year: 2026, month: 2, day: 1 },
      ),
    ).toBe(false);
  });

  it('builds a half-open one-day UTC window', () => {
    const window = dayWindow(2026, 12, 31);
    expect(window.start.toISOString()).toBe('2026-12-31T00:00:00.000Z');
    expect(window.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('inferCustodianFromEntry', () => {
  it('matches case-insensitively and prefers the longest address', () => {
    expect(
      inferCustodianFromEntry('EXPORT/ANALYST@EXAMPLE.COM-001.mbox', [
        'analyst@example.com',
        'yst@example.com',
      ]),
    ).toBe('analyst@example.com');
  });

  it('returns unknown when no custodian matches', () => {
    expect(
      inferCustodianFromEntry('export/unmatched.mbox', ['analyst@example.com']),
    ).toBe('unknown');
  });
});
