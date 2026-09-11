import {
  formatMoney as formatLedgerMoney,
  formatPrice as formatLedgerPrice,
  formatQuantity,
} from '@/lib/fundLedger';
import { applyCommas } from '@/lib/numberFormat';
import { CURRENCY_SYMBOL, normalizeCurrency } from '@/lib/currency';

export const VALUATION_METHODS = [
  { value: 'at_cost', label: 'At cost' },
  { value: 'fundraise_round', label: 'Fundraise round' },
  { value: 'secondary_sale', label: 'Secondary sale' },
  { value: 'stock_market_price', label: 'Stock market price' },
  { value: 'comparables', label: 'Comparables' },
  { value: 'capital_account_statement', label: 'Capital account statement' },
  { value: 'other', label: 'Other' },
];

// Resolve from the shared currency primitives so CNY renders as "RMB " rather
// than "¥" (the yen sign reads as Japanese Yen) and IDR as "Rp".
function currencySymbol(currency: string): string {
  return CURRENCY_SYMBOL[normalizeCurrency(currency)];
}

export function formatMoney(value: number | null | undefined, currency = 'USD'): string {
  return formatLedgerMoney(value, currencySymbol(currency));
}

/**
 * Exact, unabbreviated money for resolution panels — `RMB 1,000,000.00`.
 *
 * Deliberately NOT `formatMoney`: that one is compact (`RMB 1M`) and renders 0
 * as a dash, which is right for a ledger delta cell and wrong for a figure the
 * reviewer is being asked to approve. Only null/non-finite renders as a dash.
 * With `signed`, a sign is always shown so the direction of the adjustment is
 * explicit rather than inferred from the label.
 */
export function formatMoneyExact(
  value: number | null | undefined,
  currency = 'USD',
  opts?: { signed?: boolean },
): string {
  if (value == null || !Number.isFinite(value)) return '\u2014';
  const sign = opts?.signed ? (value < 0 ? '\u2212' : '+') : '';
  const magnitude = applyCommas(Math.abs(value).toFixed(2));
  return `${sign}${currencySymbol(currency)}${magnitude}`;
}

export function formatPrice(value: number | null | undefined, currency = 'USD'): string | null {
  return formatLedgerPrice(value, currencySymbol(currency));
}

export const formatQty = formatQuantity;

export function formatValuationNumber(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return applyCommas(value.toFixed(2));
}

export function formatValuationStake(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${applyCommas(value.toFixed(2))}%`;
}
