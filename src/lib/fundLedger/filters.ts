/**
 * The quick-filter engine behind right-clicking a cell.
 *
 * Filters narrow *what you are looking at*, never what a position is worth: the
 * sheet and the cash-flow metrics respect them, the as-of balances do not. See
 * `summarizeLedger` and `rollupPosition` for the other half of that rule.
 *
 * Pure and UI-free — the view builds menus from it, the copilot's
 * `query_ledger_entries` tool applies the same predicates to the same rows.
 */

import type { FlPortfolioLedgerEntry } from '@/lib/services/flPortfolioService';
import { flIsNegative, flIsPositive, flIsZero } from '@/lib/services/flDecimal';
import type { LedgerIndex } from './derive';
import { describeFromTo, sourceNamesOf } from './derive';
import { entryTypeLabel } from './entryTypes';
import { derivePricePerUnit, formatDateNumeric } from './format';

/** A column a filter can be built on. */
export type FilterColumn =
  | 'date'
  | 'ref'
  | 'description'
  | 'from'
  | 'to'
  | 'holder'
  | 'instrument'
  | 'source'
  | 'type'
  | 'subType'
  | 'status'
  | 'position'
  | 'commitment'
  | 'quantity'
  | 'valuation'
  | 'price'
  | 'cash';

/**
 * How a filter compares.
 *
 * `involves` is the one that isn't a plain comparison: it matches a name on
 * either side of the movement — holder, what is held, or the far leg of a
 * transfer — which is what you almost always want after right-clicking a party.
 */
export type FilterOperator =
  | 'is'
  | 'not'
  | 'includes'
  | 'involves'
  | 'has_value'
  | 'above_zero'
  | 'below_zero';

export interface LedgerFilter {
  /** Client-generated, unique within the active filter list. */
  id: string;
  column: FilterColumn;
  operator: FilterOperator;
  /** The value being compared against. Empty for the numeric operators. */
  value: string;
  /**
   * What to show in the chip when `value` is not itself readable — an entry or
   * position id, for instance. Falls back to `value`.
   */
  display?: string;
}

/** Column headings, reused by the chips and the right-click menu. */
export const FILTER_COLUMN_LABELS: Record<FilterColumn, string> = {
  date: 'Date',
  ref: 'Ref',
  description: 'Description',
  from: 'From',
  to: 'To',
  holder: 'Holder',
  instrument: 'What is held',
  source: 'Source',
  type: 'Type',
  subType: 'Sub-type',
  status: 'Status',
  position: 'Position',
  commitment: 'Commitment Δ',
  quantity: 'Quantity Δ',
  valuation: 'Value Δ',
  price: 'Price',
  cash: 'Cash Δ',
};

/** Wording for the operators that take no value. */
export const NUMERIC_OPERATOR_LABELS: Record<string, string> = {
  has_value: 'has a value',
  above_zero: 'is above zero',
  below_zero: 'is below zero',
};

/** The columns holding a signed figure, which get the numeric operators. */
const NUMERIC_COLUMNS = new Set<FilterColumn>([
  'commitment',
  'quantity',
  'valuation',
  'price',
  'cash',
]);

/** True when a column is compared as a number rather than as text. */
export function isNumericColumn(column: FilterColumn): boolean {
  return NUMERIC_COLUMNS.has(column);
}

/** The columns naming a party, which get the "involves … either way" option. */
const PARTY_COLUMNS = new Set<FilterColumn>(['from', 'to', 'holder', 'instrument']);

/** True when a column names a party on one side of the movement. */
export function isPartyColumn(column: FilterColumn): boolean {
  return PARTY_COLUMNS.has(column);
}

/**
 * The text an entry presents in a column — the same string the cell shows, so a
 * filter built by right-clicking always matches the row it came from.
 *
 * Returns `null` for a column that carries no text (the numeric ones), which is
 * how the menu decides to offer the numeric operators instead.
 */
export function filterTextValue(
  entry: FlPortfolioLedgerEntry,
  column: FilterColumn,
  index: LedgerIndex,
): string | null {
  const position = index.positions.get(entry.position_id);
  switch (column) {
    case 'date':
      return formatDateNumeric(entry.entry_date);
    case 'ref':
      return entry.id;
    case 'description':
      return entry.event?.description ?? '';
    case 'from':
      return describeFromTo(entry, index).from.name;
    case 'to':
      return describeFromTo(entry, index).to.name;
    case 'holder':
      return position?.holder.name ?? '';
    case 'instrument':
      return position?.instrument.name ?? '';
    case 'source':
      // Joined, because a row funded from several pools touches all of them.
      // `matchesFilter` also accepts any single name from this set, so a filter
      // built by picking one pool in the search box still matches.
      return sourceNamesOf(entry, index).join(' + ');
    case 'type':
      return entryTypeLabel(entry.entry_type);
    case 'subType':
      return entry.sub_type ?? '';
    case 'status':
      return entry.data_status === 'needs_verification' ? 'Needs checking' : 'Verified';
    case 'position':
      return entry.position_id;
    default:
      return null;
  }
}

/** The signed figure an entry presents in a numeric column. */
function filterNumericValue(
  entry: FlPortfolioLedgerEntry,
  column: FilterColumn,
): string | number | null {
  switch (column) {
    case 'commitment':
      return entry.commitment_delta ?? '0';
    case 'quantity':
      return entry.quantity_delta ?? '0';
    case 'valuation':
      return entry.valuation_delta ?? '0';
    case 'cash':
      return entry.cash_delta ?? '0';
    case 'price':
      return derivePricePerUnit(entry.price_per_unit, entry.quantity_delta, entry.cash_delta) ?? 0;
    default:
      return null;
  }
}

function isPositive(value: string | number): boolean {
  return typeof value === 'number' ? value > 0 : flIsPositive(value);
}

function isNegative(value: string | number): boolean {
  return typeof value === 'number' ? value < 0 : flIsNegative(value);
}

function isZero(value: string | number): boolean {
  return typeof value === 'number' ? value === 0 : flIsZero(value);
}

/** Every name this entry touches — both sides plus the far leg of a transfer. */
function involvedNames(entry: FlPortfolioLedgerEntry, index: LedgerIndex): string[] {
  const position = index.positions.get(entry.position_id);
  const names = [position?.holder.name, position?.instrument.name];
  if (entry.counterparty_position_id) {
    names.push(index.positions.get(entry.counterparty_position_id)?.holder.name);
  }
  return names.filter((name): name is string => !!name);
}

/** Whether one entry satisfies one filter. */
export function matchesFilter(
  entry: FlPortfolioLedgerEntry,
  filter: LedgerFilter,
  index: LedgerIndex,
): boolean {
  if (filter.operator === 'involves') {
    const needle = filter.value.toLowerCase();
    return involvedNames(entry, index).some((name) => name.toLowerCase() === needle);
  }

  if (filter.operator in NUMERIC_OPERATOR_LABELS) {
    const value = filterNumericValue(entry, filter.column);
    if (value == null) return false;
    if (filter.operator === 'has_value') return !isZero(value);
    return filter.operator === 'above_zero' ? isPositive(value) : isNegative(value);
  }

  const needle = filter.value.toLowerCase();

  // A source cell can stand for several pools. Match the whole cell OR any one
  // pool in it, so "Source is Aldiracita" — which is what picking a pool in the
  // search box produces — finds the rows that only name it in a funding split.
  const candidates =
    filter.column === 'source'
      ? [
          filterTextValue(entry, 'source', index) ?? '',
          ...sourceNamesOf(entry, index),
        ].map((value) => value.toLowerCase())
      : [(filterTextValue(entry, filter.column, index) ?? '').toLowerCase()];

  switch (filter.operator) {
    case 'is':
      return candidates.some((value) => value === needle);
    case 'not':
      return !candidates.some((value) => value === needle);
    case 'includes':
      return candidates.some((value) => value.includes(needle));
    default:
      return true;
  }
}

/** Whether an entry satisfies every active filter. Empty list passes everything. */
export function passesFilters(
  entry: FlPortfolioLedgerEntry,
  filters: LedgerFilter[],
  index: LedgerIndex,
): boolean {
  return filters.every((filter) => matchesFilter(entry, filter, index));
}

/**
 * A filter as a sentence, split so the view can bold the value.
 *
 * `From`/`To` read as "From <name>" rather than "From is <name>" — the column
 * name already says which direction, and the shorter form fits the chip.
 */
export function describeFilter(filter: LedgerFilter): { prefix: string; value: string } {
  const column = FILTER_COLUMN_LABELS[filter.column] ?? filter.column;
  const shown = filter.display ?? filter.value;

  if (filter.operator === 'involves') return { prefix: 'Involves', value: shown };
  if (filter.operator in NUMERIC_OPERATOR_LABELS) {
    return { prefix: `${column} ${NUMERIC_OPERATOR_LABELS[filter.operator]}`, value: '' };
  }
  if ((filter.column === 'from' || filter.column === 'to') && filter.operator === 'is') {
    return { prefix: column, value: shown };
  }
  if (filter.operator === 'is') return { prefix: `${column} is`, value: shown };
  if (filter.operator === 'not') return { prefix: `${column} not`, value: shown };
  return { prefix: `${column} includes`, value: shown };
}

/** True when the list already holds an identical filter — used to de-duplicate. */
export function hasFilter(filters: LedgerFilter[], candidate: Omit<LedgerFilter, 'id'>): boolean {
  return filters.some(
    (filter) =>
      filter.column === candidate.column &&
      filter.operator === candidate.operator &&
      filter.value === candidate.value,
  );
}
