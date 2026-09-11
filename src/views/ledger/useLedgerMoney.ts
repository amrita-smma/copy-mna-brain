'use client';

import { useMemo } from 'react';
import { CURRENCY_SYMBOL, type Currency } from '@/lib/currency';
import { useWorkspaceCurrency } from '@/components/layout/WorkspaceCurrencyContext';
import {
  formatMoney as formatMoneyRaw,
  formatMoneyAbs as formatMoneyAbsRaw,
  formatPrice as formatPriceRaw,
  type Amount,
} from '@/lib/fundLedger';

/** The ledger money formatters, pre-bound to the workspace display currency. */
export interface LedgerMoney {
  /** The workspace display currency code, e.g. `CNY` — what a draft is posted in. */
  currency: Currency;
  /** Its symbol, e.g. `RMB ` — pass to a column builder that formats its own cells. */
  symbol: string;
  /** Signed and compact — `+RMB 3.2M`. */
  money: (value: Amount) => string;
  /** Unsigned and compact — `RMB 43.78M`. */
  moneyAbs: (value: Amount) => string;
  /** A per-unit price, or `null` when there isn't one. */
  price: (value: Amount) => string | null;
}

/**
 * Every figure on the Ledger reads in the workspace display currency — the one
 * set on `workspaces.default_currency` — so the table, the metrics, the detail
 * pane and the post/edit dialogs can't disagree about what a number means. This
 * is a relabel, not a conversion: the stored amounts are untouched.
 */
export function useLedgerMoney(): LedgerMoney {
  const currency = useWorkspaceCurrency();
  return useMemo(() => {
    const symbol = CURRENCY_SYMBOL[currency];
    return {
      currency,
      symbol,
      money: (value: Amount) => formatMoneyRaw(value, symbol),
      moneyAbs: (value: Amount) => formatMoneyAbsRaw(value, symbol),
      price: (value: Amount) => formatPriceRaw(value, symbol),
    };
  }, [currency]);
}
