import { describe, it, expect } from 'vitest';
import { STALE_SOURCE_MONTHS, isStaleSource, parseCitationLabel, parseSourceDate, readPublishedDate } from './citations';

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe('parseSourceDate', () => {
  it('reads the date shapes a reply may use', () => {
    expect(parseSourceDate('12 Mar 2026')).toEqual(utc(2026, 3, 12));
    expect(parseSourceDate('12 March 2026')).toEqual(utc(2026, 3, 12));
    expect(parseSourceDate('Mar 12, 2026')).toEqual(utc(2026, 3, 12));
    expect(parseSourceDate('2026-03-12')).toEqual(utc(2026, 3, 12));
    expect(parseSourceDate('Mar 2026')).toEqual(utc(2026, 3, 1));
    expect(parseSourceDate('2026')).toEqual(utc(2026, 1, 1));
    expect(parseSourceDate('last week')).toBeNull();
  });
});

describe('parseCitationLabel', () => {
  it('splits a citation into its source and date', () => {
    expect(parseCitationLabel('Reuters, 12 Mar 2026')).toEqual({
      source: 'Reuters',
      dateText: '12 Mar 2026',
      date: utc(2026, 3, 12),
    });
    expect(parseCitationLabel('Bank Indonesia, Q1 report, Mar 12, 2026')).toEqual({
      source: 'Bank Indonesia, Q1 report',
      dateText: 'Mar 12, 2026',
      date: utc(2026, 3, 12),
    });
    expect(parseCitationLabel('Company site, undated')).toEqual({ source: 'Company site', dateText: 'undated', date: null });
    expect(parseCitationLabel('Reuters, 12 Mar 2024 · dated')?.dateText).toBe('12 Mar 2024');
  });

  it('leaves an ordinary link alone', () => {
    expect(parseCitationLabel('the filing')).toBeNull();
    expect(parseCitationLabel('Smith, Jones and Co')).toBeNull();
    expect(parseCitationLabel('Smith, 2024')).toBeNull();
    expect(parseCitationLabel('https://example.com')).toBeNull();
  });

  it('still treats a year-only citation as dated when the source is not a lone name', () => {
    expect(parseCitationLabel('Annual report, 2024')?.dateText).toBe('2024');
  });
});

describe('isStaleSource', () => {
  const now = utc(2026, 10, 15);
  it(`flags a source older than ${STALE_SOURCE_MONTHS} months`, () => {
    expect(isStaleSource(utc(2025, 10, 16), now, 12)).toBe(false);
    expect(isStaleSource(utc(2025, 10, 14), now, 12)).toBe(true);
    expect(isStaleSource(utc(2026, 5, 1), now, 3)).toBe(true);
  });
});

describe('readPublishedDate', () => {
  it("labels a search result's date, and ignores one it cannot read", () => {
    expect(readPublishedDate('2026-03-12')).toEqual({ label: '12 Mar 2026', date: utc(2026, 3, 12) });
    expect(readPublishedDate('2026-03-12T08:30:00Z')?.label).toBe('12 Mar 2026');
    expect(readPublishedDate('sometime')).toBeNull();
    expect(readPublishedDate(undefined)).toBeNull();
  });
});
