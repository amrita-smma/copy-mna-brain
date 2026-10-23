import { describe, expect, it } from 'vitest';
import {
  coveredWindowStarts,
  currentDayUTC,
  dayWindow,
  daysBetween,
  inferCustodianFromEntry,
  MAX_WINDOW_EXPORT_ATTEMPTS,
  parseFloorDay,
  previousDay,
  resolveRewind,
  ymdLessThanOrEqual,
} from './vaultArchive';

describe('coveredWindowStarts', () => {
  const day1 = '2026-09-01 00:00:00+00';
  const day2 = '2026-09-02 00:00:00+00';

  it('covers a window with any non-failed export', () => {
    const covered = coveredWindowStarts([
      { window_start: day1, status: 'archived' },
      { window_start: day2, status: 'failed' },
    ]);
    expect([...covered]).toEqual(['2026-09-01T00:00:00.000Z']);
  });

  it('gives up on a window once its exports failed the maximum number of times', () => {
    const rows = Array.from({ length: MAX_WINDOW_EXPORT_ATTEMPTS }, () => ({
      window_start: day2,
      status: 'failed',
    }));
    expect(coveredWindowStarts(rows).has('2026-09-02T00:00:00.000Z')).toBe(true);
    expect(coveredWindowStarts(rows.slice(1)).has('2026-09-02T00:00:00.000Z')).toBe(false);
  });
});

describe('resolveRewind', () => {
  it('parses an inclusive day range; without startedAt every re-extract export counts', () => {
    expect(resolveRewind({ from: '2026-09-01', to: '2026-09-30' })).toEqual({
      from: { year: 2026, month: 9, day: 1 },
      to: { year: 2026, month: 9, day: 30 },
      startedAtIso: '1970-01-01T00:00:00.000Z',
    });
  });

  it('normalizes startedAt to ISO', () => {
    expect(
      resolveRewind({ from: '2026-09-01', to: '2026-09-01', startedAt: '2026-10-22T08:00:00+07:00' })
        .startedAtIso,
    ).toBe('2026-10-22T01:00:00.000Z');
  });

  it('rejects a bad day, a reversed range and a bad startedAt', () => {
    expect(() => resolveRewind({ from: '2026/09/01', to: '2026-09-02' })).toThrow('rewind.from');
    expect(() => resolveRewind({ from: '2026-09-02', to: '2026-09-01' })).toThrow('after rewind.to');
    expect(() =>
      resolveRewind({ from: '2026-09-01', to: '2026-09-02', startedAt: 'yesterday' }),
    ).toThrow('rewind.startedAt');
  });
});

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
