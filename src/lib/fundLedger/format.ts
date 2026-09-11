/**
 * Display formatting for ledger figures.
 *
 * Ledger amounts arrive as `numeric(38,8)` decimal strings. Anything that has
 * to be *exact* on screen (the delta columns in the expanded detail, the
 * posting preview) goes through `flDecimal`'s BigInt arithmetic; the compact
 * "$43.78M" forms bucket by magnitude, where a double is precise enough and a
 * BigInt would only cost readability.
 *
 * Shared by the Ledger view and the `query_ledger_entries` tool so a number
 * reads the same in the table as it does in a copilot answer.
 */

import { toDecimalString } from '@/lib/services/flDecimal';

/** A signed amount as it comes off the wire, or already parsed. */
export type Amount = string | number | null | undefined;

/**
 * The English rendering of a name, or `undefined` when it adds nothing — unset,
 * blank, or just a restatement of the name it sits under.
 *
 * Shared so a name and the string searched for it can never disagree: every
 * surface that shows the English line also matches on it.
 */
export function distinctEnglishName(
  name: string,
  englishName?: string | null,
): string | undefined {
  const english = englishName?.trim();
  if (!english) return undefined;
  if (english.toLocaleLowerCase() === name.trim().toLocaleLowerCase()) return undefined;
  return english;
}

/** The em-dash the sheet shows in place of a zero or missing figure. */
export const EMPTY_CELL = '—';

const MINUS = '−';

/**
 * Best-effort numeric value of an amount, for magnitude bucketing and sign
 * tests. Returns 0 for anything unparseable so a malformed row renders as a
 * dash rather than `NaN`.
 */
export function toNumber(value: Amount): number {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Group the integer part of an already-formatted decimal string with commas. */
function withThousands(decimal: string): string {
  const negative = decimal.startsWith('-');
  const bare = negative ? decimal.slice(1) : decimal;
  const [whole, fraction] = bare.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = fraction ? `${grouped}.${fraction}` : grouped;
  return negative ? `${MINUS}${body}` : body;
}

/**
 * Exact, fully written out to `scale` decimal places — "−43,780,000.00".
 *
 * Uses BigInt arithmetic rather than `toFixed`, so a position worth more than
 * 2^53 minor units still shows every digit it was stored with.
 */
export function formatExact(value: Amount, scale = 2): string {
  if (value == null) return (0).toFixed(scale);
  try {
    return withThousands(toDecimalString(String(value), scale));
  } catch {
    return (0).toFixed(scale);
  }
}

/**
 * Exact, at whatever precision the value actually carries — "2,210,000.00",
 * "0.001".
 *
 * Quantities are stored with eight decimals, and a fund with fractional units
 * would have them silently rounded away by a fixed two-place format. This
 * renders the full stored precision, strips the trailing zeros that adds, and
 * pads back to `minScale` so whole numbers still line up with the money
 * columns beside them.
 */
export function formatExactAuto(value: Amount, minScale = 2, maxScale = 8): string {
  if (value == null) return (0).toFixed(minScale);
  let full: string;
  try {
    full = toDecimalString(String(value), maxScale);
  } catch {
    return (0).toFixed(minScale);
  }
  const [whole, fraction = ''] = full.split('.');
  const trimmed = fraction.replace(/0+$/, '');
  const padded = trimmed.padEnd(minScale, '0');
  return withThousands(padded ? `${whole}.${padded}` : whole);
}

/** Magnitude bucketed to a K/M suffix — "43.78M", "250K", "980". */
function compactMagnitude(size: number): string {
  if (size >= 1_000_000) return `${(size / 1_000_000).toFixed(2).replace(/\.00$/, '')}M`;
  if (size >= 1_000) return `${(size / 1_000).toFixed(0)}K`;
  return size.toFixed(0);
}

/**
 * Compact and signed — "+$3.2M", "−$43.78M". Zero and missing render as a dash,
 * because a ledger cell that shows "$0" reads as a posted zero rather than as
 * "this type never touches this column".
 */
export function formatMoney(value: Amount, currency = '$'): string {
  const num = toNumber(value);
  if (num === 0) return EMPTY_CELL;
  const sign = num < 0 ? MINUS : '+';
  return `${sign}${currency}${compactMagnitude(Math.abs(num))}`;
}

/** Compact and unsigned — "$43.78M". Used for totals that can't be negative. */
export function formatMoneyAbs(value: Amount, currency = '$'): string {
  return `${currency}${compactMagnitude(Math.abs(toNumber(value)))}`;
}

/** Signed unit count with thousands separators — "+9,500,000". */
export function formatQuantity(value: Amount): string {
  const num = toNumber(value);
  if (num === 0) return EMPTY_CELL;
  const sign = num < 0 ? MINUS : '+';
  return `${sign}${Math.abs(num).toLocaleString('en-US')}`;
}

/** Unsigned unit count — "9,500,000". */
export function formatQuantityAbs(value: Amount): string {
  return Math.abs(toNumber(value)).toLocaleString('en-US');
}

/**
 * A per-unit price. Prices below $100 keep four decimals because early-stage
 * marks routinely differ in the third; above that two is plenty.
 */
export function formatPrice(value: Amount, currency = '$'): string | null {
  if (value == null || value === '') return null;
  const num = toNumber(value);
  if (num === 0) return null;
  return `${currency}${Math.abs(num) >= 100 ? num.toFixed(2) : num.toFixed(4)}`;
}

/**
 * The price a movement actually happened at.
 *
 * Prefers the recorded `price_per_unit`; where the source never captured one it
 * is derived as cash ÷ units. When neither exists the caller shows "no price"
 * rather than a zero, which would read as free.
 */
export function derivePricePerUnit(
  pricePerUnit: Amount,
  quantityDelta: Amount,
  cashDelta: Amount,
): number | null {
  if (pricePerUnit != null && pricePerUnit !== '') {
    const explicit = toNumber(pricePerUnit);
    if (explicit !== 0) return explicit;
  }
  const units = toNumber(quantityDelta);
  const cash = toNumber(cashDelta);
  if (units === 0 || cash === 0) return null;
  return Math.abs(cash / units);
}

/** Sign class for a cell — the view maps these to colours. */
export function signOf(value: Amount): 'positive' | 'negative' | 'zero' {
  const num = toNumber(value);
  if (num > 0) return 'positive';
  if (num < 0) return 'negative';
  return 'zero';
}

/** Parse an ISO date (`YYYY-MM-DD`) as local midnight, never UTC-shifted. */
function parseIsoDate(iso: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return null;
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

/** "15 Jan 2018". */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return EMPTY_CELL;
  const date = parseIsoDate(iso);
  if (!date) return iso;
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/** "15 Jan 18" — for metric subtitles, where the century is never in doubt. */
export function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return EMPTY_CELL;
  const date = parseIsoDate(iso);
  if (!date) return iso;
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
  });
}

/** "15/01/18" — the dense form the date column uses. */
export function formatDateNumeric(iso: string | null | undefined): string {
  if (!iso) return EMPTY_CELL;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return iso;
  const [, year, month, day] = match;
  return `${day}/${month}/${year.slice(2)}`;
}

/** "15/01/2018" — the form the date inputs accept and echo. */
export function formatDateInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return '';
  const [, year, month, day] = match;
  return `${day}/${month}/${year}`;
}

/**
 * Parse "dd/mm/yyyy" back to an ISO date, or `null` when it isn't a real day.
 * Rejects overflow like 31/02/2026 rather than silently rolling into March.
 */
export function parseDateInput(value: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return toIsoDate(date);
}

/** A `Date` as `YYYY-MM-DD` in local time. */
export function toIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** `iso` shifted by `days`, as an ISO date. */
export function addDays(iso: string, days: number): string {
  const date = parseIsoDate(iso);
  if (!date) return iso;
  date.setDate(date.getDate() + days);
  return toIsoDate(date);
}
