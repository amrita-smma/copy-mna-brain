import { describe, expect, it } from 'vitest';
import { buildLedgerIndex, summarizeLedger } from './derive';
import {
  emptyQuery,
  entriesAsOf,
  isQueryNarrowed,
  sortEntriesNewestFirst,
  sortEntriesOldestFirst,
  visibleEntries,
  windowEntries,
  type LedgerQuery,
} from './query';
import { ENTRIES, buildTestPortfolio } from './testFixtures';

const index = buildLedgerIndex(buildTestPortfolio());
const TODAY = '2026-08-31';

const ids = (entries: { id: string }[]) => entries.map((entry) => entry.id).sort();

describe('entriesAsOf', () => {
  it('takes everything from inception up to the as-of date', () => {
    expect(entriesAsOf(index, TODAY)).toHaveLength(index.entries.length);
  });

  it('excludes rows dated after the as-of date', () => {
    const early = entriesAsOf(index, '2021-12-31');
    expect(ids(early)).toEqual([
      'le-1982',
      'le-aku-buy',
      'le-call4',
      'le-commit',
      'le-goto-buy',
    ]);
  });

  it('includes a row dated exactly on the as-of date', () => {
    expect(ids(entriesAsOf(index, '2018-01-15'))).toEqual(['le-commit']);
  });

  it('returns nothing before the first row', () => {
    expect(entriesAsOf(index, '2000-01-01')).toEqual([]);
  });
});

describe('windowEntries', () => {
  it('narrows to the from-date without touching the as-of set', () => {
    const query: LedgerQuery = { ...emptyQuery(TODAY), from: '2025-01-01' };
    expect(ids(windowEntries(index, query))).toEqual([
      'le-dist',
      'le-fee-bad',
      'le-fee-rev',
      'le-income',
      'le-writeoff',
    ]);
    expect(entriesAsOf(index, TODAY)).toHaveLength(index.entries.length);
  });

  it('applies the quick filters', () => {
    const query: LedgerQuery = {
      ...emptyQuery(TODAY),
      filters: [{ id: 'a', column: 'type', operator: 'is', value: 'Buy' }],
    };
    expect(ids(windowEntries(index, query))).toEqual(['le-aku-buy', 'le-goto-buy']);
  });

  it('ignores the two chip controls, which narrow only what is listed', () => {
    const query: LedgerQuery = {
      ...emptyQuery(TODAY),
      entryType: 'buy',
      onlyNeedsChecking: true,
    };
    expect(windowEntries(index, query)).toHaveLength(index.entries.length);
  });
});

describe('visibleEntries', () => {
  it('narrows by the type chip', () => {
    const query: LedgerQuery = { ...emptyQuery(TODAY), entryType: 'buy' };
    expect(ids(visibleEntries(index, query))).toEqual(['le-aku-buy', 'le-goto-buy']);
  });

  it('narrows to the rows that still need checking', () => {
    const query: LedgerQuery = { ...emptyQuery(TODAY), onlyNeedsChecking: true };
    expect(ids(visibleEntries(index, query))).toEqual(['le-1982']);
  });

  it('stacks the range, the filters and both chips', () => {
    const query: LedgerQuery = {
      asOf: TODAY,
      from: '2021-01-01',
      entryType: 'paid_in',
      onlyNeedsChecking: true,
      filters: [{ id: 'a', column: 'holder', operator: 'involves', value: 'Startech Growth Fund VCC' }],
    };
    expect(ids(visibleEntries(index, query))).toEqual(['le-1982']);
  });

  it('returns nothing when the filters exclude everything', () => {
    const query: LedgerQuery = {
      ...emptyQuery(TODAY),
      filters: [{ id: 'a', column: 'type', operator: 'is', value: 'Sell' }],
    };
    expect(visibleEntries(index, query)).toEqual([]);
  });
});

describe('the two scopes together', () => {
  it("keeps commitment counting past the from-date while cash flows respect it", () => {
    // The whole point of the split: 'From' narrows what is listed, not what is
    // pledged. The commitment rows all predate 2025.
    const query: LedgerQuery = { ...emptyQuery(TODAY), from: '2025-01-01' };
    const summary = summarizeLedger(entriesAsOf(index, query.asOf), windowEntries(index, query));
    expect(summary.commitment).toBe('50000000.00000000');
    expect(summary.cashInRows).toBe(3);
  });

  it('moves the balances when the as-of date moves back', () => {
    const query: LedgerQuery = emptyQuery('2018-06-30');
    const summary = summarizeLedger(entriesAsOf(index, query.asOf), windowEntries(index, query));
    // Only the $50M pledge and the GOTO cheque exist by mid-2018.
    expect(summary.commitment).toBe('50000000.00000000');
    expect(summary.cashOut).toBe('43780000.00000000');
  });
});

describe('sorting', () => {
  it('lists the newest row first for the entry view', () => {
    const sorted = sortEntriesNewestFirst(index.entries);
    expect(sorted[0].entry_date).toBe('2026-04-02');
    expect(sorted[sorted.length - 1].entry_date).toBe('2018-01-15');
  });

  it('reads a position history oldest first', () => {
    const sorted = sortEntriesOldestFirst(index.entries);
    expect(sorted[0].entry_date).toBe('2018-01-15');
  });

  it('puts the row recorded first ahead of it when two share an entry date', () => {
    // Both are dated 2026-03-31; only the moment they were posted separates them.
    const early = { ...ENTRIES.writeOff, created_at: '2026-04-01T09:00:00.000Z' };
    const late = { ...ENTRIES.feeWrong, created_at: '2026-04-01T17:30:00.000Z' };
    expect(ids(sortEntriesNewestFirst([early, late]))).toEqual(
      ids(sortEntriesOldestFirst([early, late])),
    );
    expect(sortEntriesOldestFirst([late, early]).map((entry) => entry.id)).toEqual([
      'le-writeoff',
      'le-fee-bad',
    ]);
    expect(sortEntriesNewestFirst([early, late]).map((entry) => entry.id)).toEqual([
      'le-fee-bad',
      'le-writeoff',
    ]);
  });

  it('compares created_at as an instant, not as text', () => {
    // The same moment spelled the two ways it reaches us — postgres' own
    // rendering and the JSON round-trip. Lexically ' ' sorts before 'T', so a
    // string compare would call the later row earlier.
    const pgStyle = { ...ENTRIES.writeOff, created_at: '2026-04-01 17:00:00+00' };
    const jsonStyle = { ...ENTRIES.feeWrong, created_at: '2026-04-01T09:00:00.000Z' };
    expect(sortEntriesOldestFirst([pgStyle, jsonStyle]).map((entry) => entry.id)).toEqual([
      'le-fee-bad',
      'le-writeoff',
    ]);
  });

  it('falls back to the id when the entry date and created_at both match', () => {
    // Rows written in one transaction share created_at to the microsecond.
    const sameDay = [ENTRIES.feeWrong, ENTRIES.writeOff];
    expect(ids(sortEntriesNewestFirst(sameDay))).toEqual(ids(sortEntriesOldestFirst(sameDay)));
    expect(sortEntriesNewestFirst(sameDay)[0].id).toBe('le-writeoff');
    expect(sortEntriesOldestFirst(sameDay)[0].id).toBe('le-fee-bad');
  });

  it('treats a missing created_at as the earliest rather than breaking the sort', () => {
    const missing = { ...ENTRIES.writeOff, created_at: '' };
    const known = { ...ENTRIES.feeWrong, created_at: '2026-04-01T09:00:00.000Z' };
    expect(sortEntriesOldestFirst([known, missing]).map((entry) => entry.id)).toEqual([
      'le-writeoff',
      'le-fee-bad',
    ]);
  });

  it('does not mutate the array it was given', () => {
    const original = [...index.entries];
    sortEntriesNewestFirst(index.entries);
    expect(index.entries).toEqual(original);
  });
});

describe('isQueryNarrowed', () => {
  it('is false for an untouched query', () => {
    expect(isQueryNarrowed(emptyQuery(TODAY))).toBe(false);
  });

  it('is true as soon as any control is set', () => {
    expect(isQueryNarrowed({ ...emptyQuery(TODAY), from: '2025-01-01' })).toBe(true);
    expect(isQueryNarrowed({ ...emptyQuery(TODAY), entryType: 'buy' })).toBe(true);
    expect(isQueryNarrowed({ ...emptyQuery(TODAY), onlyNeedsChecking: true })).toBe(true);
    expect(
      isQueryNarrowed({
        ...emptyQuery(TODAY),
        filters: [{ id: 'a', column: 'type', operator: 'is', value: 'Buy' }],
      }),
    ).toBe(true);
  });
});
