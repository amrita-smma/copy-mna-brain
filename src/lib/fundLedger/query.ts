/**
 * Narrowing the ledger down to the rows on screen.
 *
 * The date control sets two different things. **To** is the as-of date:
 * balances, commitment and blended price always count from inception up to it,
 * so a position's history is never truncated. **From** only narrows which rows
 * are listed and which cash flows the top metrics total — which is why a
 * position keeps counting past it.
 *
 * Three widening scopes, and the difference between them is the whole
 * behaviour of the page:
 *
 * - {@link entriesAsOf} — inception → as-of. What balances are counted from.
 * - {@link windowEntries} — plus the "from" date and the quick filters. What
 *   the cash-flow metrics total and what the type chips count.
 * - {@link visibleEntries} — plus the type chip and "needs checking only".
 *   What the sheet lists.
 */

import type { FlPortfolioLedgerEntry } from '@/lib/services/flPortfolioService';
import type { LedgerIndex } from './derive';
import type { FlEntryType } from './entryTypes';
import { passesFilters, type LedgerFilter } from './filters';

/** Everything the page's controls currently say. */
export interface LedgerQuery {
  /** The as-of date. Balances always count from inception up to here. */
  asOf: string;
  /** Start of the listed range, or `null` for since-inception. */
  from: string | null;
  /** The type chip, or `'all'`. */
  entryType: FlEntryType | 'all';
  /** The "needs checking only" chip. */
  onlyNeedsChecking: boolean;
  /** Quick filters added by right-clicking a cell or picking an entity. */
  filters: LedgerFilter[];
}

/** A query with nothing narrowed, as of the given date. */
export function emptyQuery(asOf: string): LedgerQuery {
  return { asOf, from: null, entryType: 'all', onlyNeedsChecking: false, filters: [] };
}

/**
 * Every entry from inception up to the as-of date, newest last.
 *
 * This is the set balances are counted from — never narrowed by the range or
 * the filters, so what a position is worth doesn't change as you look around.
 */
export function entriesAsOf(index: LedgerIndex, asOf: string): FlPortfolioLedgerEntry[] {
  return index.entries.filter((entry) => entry.entry_date <= asOf);
}

/**
 * The rows the metrics total: as-of, plus the "from" date and the quick
 * filters, but *not* the type chip or "needs checking only" — those narrow what
 * is listed without changing what the totals above are counting.
 */
export function windowEntries(index: LedgerIndex, query: LedgerQuery): FlPortfolioLedgerEntry[] {
  return entriesAsOf(index, query.asOf).filter(
    (entry) =>
      (!query.from || entry.entry_date >= query.from) &&
      passesFilters(entry, query.filters, index),
  );
}

/** The rows the sheet lists — the window, narrowed by the two chip controls. */
export function visibleEntries(index: LedgerIndex, query: LedgerQuery): FlPortfolioLedgerEntry[] {
  return windowEntries(index, query).filter((entry) => {
    if (query.entryType !== 'all' && entry.entry_type !== query.entryType) return false;
    if (query.onlyNeedsChecking && entry.data_status !== 'needs_verification') return false;
    return true;
  });
}

/**
 * Oldest-first ordering of two rows: the entry date, then the moment the row
 * was recorded, then the id.
 *
 * `entry_date` is the economic date and only has day resolution, so several
 * rows routinely share one. `created_at` breaks that tie in the order the rows
 * were actually posted — for a backfilled or imported batch that is import
 * order, which is still the order someone entered them in. The id is the last
 * resort: it is a random UUID, so it decides nothing meaningful, it only keeps
 * the order stable when two rows were written in the same transaction and share
 * a `created_at` to the microsecond.
 *
 * `created_at` is compared as a parsed instant rather than as text: it arrives
 * as a timestamptz string whose spelling varies (`... 12:00:00+00` from pg,
 * `...T12:00:00.000Z` over JSON), and those two spellings do not sort
 * lexicographically against each other.
 */
export function compareLedgerRowsOldestFirst(
  a: LedgerRowOrder,
  b: LedgerRowOrder,
): number {
  const byDate = (a.entry_date ?? '').localeCompare(b.entry_date ?? '');
  if (byDate !== 0) return byDate;
  const byCreated = createdAtMs(a) - createdAtMs(b);
  if (byCreated !== 0) return byCreated;
  return (a.id ?? '').localeCompare(b.id ?? '');
}

/**
 * The three fields the ordering reads. Kept structural so the cash movement
 * view, whose rows come through a looser type, orders identically.
 */
export interface LedgerRowOrder {
  entry_date?: string | null;
  created_at?: string | null;
  id?: string | null;
}

/** `created_at` as an instant, or 0 when it is missing or unparseable. */
function createdAtMs(row: LedgerRowOrder): number {
  const parsed = Date.parse(row.created_at ?? '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** The listed rows, newest first — the order the entry view shows them in. */
export function sortEntriesNewestFirst(
  entries: FlPortfolioLedgerEntry[],
): FlPortfolioLedgerEntry[] {
  return [...entries].sort((a, b) => compareLedgerRowsOldestFirst(b, a));
}

/** The listed rows oldest first — the order a position's history reads in. */
export function sortEntriesOldestFirst(
  entries: FlPortfolioLedgerEntry[],
): FlPortfolioLedgerEntry[] {
  return [...entries].sort(compareLedgerRowsOldestFirst);
}

/** True when anything at all is narrowing the view. */
export function isQueryNarrowed(query: LedgerQuery): boolean {
  return (
    query.from !== null ||
    query.entryType !== 'all' ||
    query.onlyNeedsChecking ||
    query.filters.length > 0
  );
}
