// Shared currency primitives used across the app: the workspace default
// currency setting, the Fund Management editors, and the company/pipeline
// money displays all resolve their symbol/format from here. Deliberately has
// NO 'use client' directive so the server (workspaceService) can import it too.

export type Currency = 'USD' | 'IDR' | 'CNY';
export const CURRENCIES: Currency[] = ['USD', 'IDR', 'CNY'];
export const CURRENCY_SYMBOL: Record<Currency, string> = { USD: '$', IDR: 'Rp', CNY: '¥' };
export const DEFAULT_CURRENCY: Currency = 'USD';

/** Normalizes a free-text currency string to one of the supported codes. */
export function normalizeCurrency(v: string | null | undefined): Currency {
  const code = v?.toUpperCase();
  if (code === 'IDR') return 'IDR';
  if (code === 'CNY') return 'CNY';
  return 'USD';
}

/**
 * Formats a value already expressed in MILLIONS as compact money, preserving
 * the shape the company/pipeline views have always used: `$312.50M` /
 * `$1.25B` (2 decimals, 1000-million threshold), `-` for null.
 *
 * With `codePrefix`, the ISO code is used instead of the symbol, e.g.
 * `IDR 312.50M` (used by the Dashboard-style labels).
 */
export function formatMoneyMn(
  value: number | null | undefined,
  currency: Currency,
  opts?: { codePrefix?: boolean },
): string {
  if (value === null || value === undefined) return '-';
  const prefix = opts?.codePrefix ? `${currency} ` : CURRENCY_SYMBOL[currency];
  if (Math.abs(value) >= 1000) {
    return `${prefix}${(value / 1000).toFixed(2)}B`;
  }
  return `${prefix}${value.toFixed(2)}M`;
}
