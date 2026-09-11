/**
 * Number formatting and parsing for display and for numeric form fields.
 *
 * These started out beside Fund Management (`src/views/fundManagement/calc.ts`,
 * which now re-exports them so its call sites are unchanged), but every numeric
 * field in the app wants the same behaviour: thousand separators applied while
 * the user types, a caret that stays where they put it, and lenient parsing on
 * commit. Keeping one copy here means a figure is grouped the same way in the
 * fund tables, the ledger form, and anything added later.
 *
 * Everything here is pure and string-in/string-out where it can be, so a caller
 * holding an exact `numeric(38,8)` decimal (the fund ledger does) can group it
 * for display without ever routing the value through a lossy `number`.
 */

/** Strips a trailing `.0`/`.00` from a fixed-precision string. */
function trimZeros(s: string): string {
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

/** Removes thousand separators, leaving a bare numeric string. */
export function stripCommas(s: string): string {
  return s.replace(/,/g, '');
}

/**
 * Apply thousand-separator commas to a raw numeric string in-place.
 * Preserves a leading minus sign, a trailing decimal point, and any
 * digits after the decimal. Used for real-time input formatting where
 * the value has already had commas stripped.
 */
export function applyCommas(s: string): string {
  if (!s) return s;
  const neg = s.startsWith('-');
  const abs = neg ? s.slice(1) : s;
  const dotIdx = abs.indexOf('.');
  const intStr = dotIdx >= 0 ? abs.slice(0, dotIdx) : abs;
  const decStr = dotIdx >= 0 ? abs.slice(dotIdx) : '';
  return (neg ? '-' : '') + intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + decStr;
}

/** `2000 -> "2,000"`, `1234.5 -> "1,234.5"`. Groups the integer part only. */
export function formatGrouped(n: number): string {
  if (!Number.isFinite(n)) return '';
  const neg = n < 0;
  const [intPart, decPart] = Math.abs(n).toString().split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}${decPart ? `.${decPart}` : ''}`;
}

/** `2000000 -> "2M"`, `2500 -> "2.5k"`, `1.5e9 -> "1.5B"`, `500 -> "500"`. */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return '';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${trimZeros((abs / 1e9).toFixed(2))}B`;
  if (abs >= 1e6) return `${sign}${trimZeros((abs / 1e6).toFixed(2))}M`;
  if (abs >= 1e3) return `${sign}${trimZeros((abs / 1e3).toFixed(2))}k`;
  return `${sign}${trimZeros(abs.toFixed(2))}`;
}

/** `1.568279 -> "1.57%"`. Percentages display with exactly two decimals. */
export function formatPercentage(n: number): string {
  if (!Number.isFinite(n)) return '';
  return `${n.toFixed(2)}%`;
}

/** Parses grouped/compact user input back to a number. Accepts commas and a
 * trailing k/m/b suffix so re-editing a compacted value round-trips. */
export function parseCurrencyInput(raw: string): number | null {
  const s = raw.trim().replace(/,/g, '');
  if (s === '') return null;
  const m = s.match(/^(-?\d*\.?\d+)\s*([kKmMbB]?)$/);
  if (!m) return null;
  const base = parseFloat(m[1]);
  if (!Number.isFinite(base)) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] ?? 1;
  return base * mult;
}

/** Characters that carry no numeric meaning, so removing them cannot change
 * the value: whitespace and a pasted currency symbol. */
function dropNoise(s: string): string {
  return s.replace(/[\s$€£¥₩₹]/g, '');
}

/** A plain decimal, optionally with the `k`/`m`/`b` multiplier some fields
 * accept. Deliberately narrow — see {@link groupNumericText}. */
function isRecognisedNumber(s: string, allowSuffix: boolean): boolean {
  return (allowSuffix ? /^-?\d*\.?\d*[kKmMbB]?$/ : /^-?\d*\.?\d*$/).test(s);
}

/**
 * `value` with thousand separators — when it is a number this understands.
 *
 * Anything else is returned exactly as typed. Deleting the characters it does
 * not recognise would silently rewrite the amount rather than reject it:
 * `1e7` would become `17` (`toDecimalString` expands scientific notation, so
 * that input is meaningful), and a `1.5m` typed out of Fund Management habit
 * would become `1.5` — a valid, thousand-fold-too-small post. Refusing the
 * value is the field's own job; this function only ever changes how it looks.
 */
export function groupNumericText(
  value: string,
  { allowSuffix = false }: { allowSuffix?: boolean } = {},
): string {
  const cleaned = dropNoise(stripCommas(value));
  return isRecognisedNumber(cleaned, allowSuffix) ? applyCommas(cleaned) : value;
}

/**
 * Where the caret belongs in `text` once `rawIndex` ungrouped characters sit
 * behind it. Counting in ungrouped characters is what keeps the caret put: the
 * digit the user just typed may have pushed a separator in ahead of it.
 */
function caretAfterGrouping(text: string, rawIndex: number): number {
  if (rawIndex <= 0) return 0;
  let remaining = rawIndex;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ',') remaining -= 1;
    if (remaining === 0) return i + 1;
  }
  return text.length;
}

/**
 * Regroup a numeric field the user is typing into.
 *
 * Takes the field's current text and caret offset, and returns the text it
 * should show (`text`, grouped), the text the caller should store (`value`,
 * ungrouped), and where the caret should land — all three have to be computed
 * together, because re-grouping shifts every position after the edit.
 *
 * Input this doesn't recognise as a number comes back untouched in both forms,
 * so nothing is rewritten behind the user (see {@link groupNumericText}).
 *
 * Set `allowSuffix` where a trailing `k`/`m`/`b` multiplier is meaningful (it is
 * expanded by {@link parseCurrencyInput} on commit).
 */
export function regroupNumericInput(
  value: string,
  caret: number,
  { allowSuffix = false }: { allowSuffix?: boolean } = {},
): { text: string; value: string; caret: number } {
  const cleaned = dropNoise(stripCommas(value));
  if (!isRecognisedNumber(cleaned, allowSuffix)) return { text: value, value, caret };
  const before = dropNoise(stripCommas(value.slice(0, caret)));
  const text = applyCommas(cleaned);
  return { text, value: cleaned, caret: caretAfterGrouping(text, before.length) };
}
