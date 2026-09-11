/**
 * Pure row-building logic for fund cash movement history (bank-statement view).
 *
 * All money arithmetic runs through `flDecimal` string helpers (`flAdd`, `toDecimalString`, etc.)
 * — never JS `number`.
 *
 * Rules implemented:
 * - One group/sub-table per currency with its own running balance. Never mix currencies.
 * - Stable ascending sort by `entry_date`, then `created_at`, then entry `id`;
 *   an `opening_balance` row is pinned ahead of anything sharing its date.
 * - Accumulate running balance row by row.
 * - Primary entry resolution via `source_ledger_entry_id` to describe WHY each movement happened.
 * - Opening balance rows (`sub_type === 'opening_balance'`) show 'Opening balance'.
 * - FX transfer legs (`counterparty_position_id` set, no `source_ledger_entry_id`) show 'FX transfer' and name the counterparty currency.
 * - Graceful fallback when a primary entry or name is unresolvable.
 * - Reversals kept as rows with `isReversal: true`.
 * - As-of date filtering (`entry_date <= asOfDate`).
 */

import {
  flAdd,
  toDecimalString,
} from '@/lib/services/flDecimal';
import { entryTypeSpec } from './entryTypes';
import { compareLedgerRowsOldestFirst } from './query';
import { SUB_TYPE_DIVESTMENT_CASH_IN_FUND } from '@/lib/sellProceedsDestination';
import type { FlPortfolioLedgerEntry, FlPortfolioPosition } from '@/lib/api/fundLedger/types';

export type CashPositionParam = FlPortfolioPosition | {
  id?: string;
  holder_investor_id?: string | null;
  holder_fund_id?: string | null;
  fund_id?: string | null;
  asset_id?: string | null;
  currency?: string | null;
  asset?: { name?: string | null; asset_kind?: string | null; instrument_terms?: unknown } | null;
  fund?: { name?: string | null } | null;
  holder_investor?: { name?: string | null } | null;
  balance?: { asset_kind?: string | null; cash_total?: string | null } | null;
  [key: string]: unknown;
};

export type CashEntryParam = FlPortfolioLedgerEntry | {
  id?: string;
  position_id?: string;
  entry_type?: string | null;
  entry_date?: string | null;
  cash_delta?: string | number | null;
  currency?: string | null;
  source_ledger_entry_id?: string | null;
  counterparty_position_id?: string | null;
  is_reversal?: boolean | null;
  sub_type?: string | null;
  notes?: string | null;
  [key: string]: unknown;
};

export interface CashHistoryRow {
  id: string;
  date: string;
  typeLabel: string;
  detail: string;
  amount: string;
  runningBalance: string;
  notes: string | null;
  isReversal: boolean;
  isOpeningBalance: boolean;
}

export interface BuildCashHistoryOptions {
  asOfDate?: string | null;
  positions?: CashPositionParam[];
  entityNames?: Map<string, string> | Record<string, string>;
  [key: string]: unknown;
}

export interface CashHistoryCurrencyGroup {
  currency: string;
  rows: CashHistoryRow[];
  closingBalance: string;
}

/**
 * Resolves the currency for a cash position using the same precedence as `fundCashSummary.ts`.
 */
export function resolveCashPositionCurrency(
  pos: CashPositionParam,
  entries?: CashEntryParam[],
  fallbackCurrency = 'USD',
): string {
  if (pos?.asset?.instrument_terms && typeof pos.asset.instrument_terms === 'object') {
    const c = (pos.asset.instrument_terms as Record<string, unknown>).currency;
    if (typeof c === 'string' && c.trim()) {
      return c.trim().toUpperCase();
    }
  }
  const directCcy = (pos as unknown as { currency?: unknown })?.currency;
  if (typeof directCcy === 'string' && directCcy.trim()) {
    return directCcy.trim().toUpperCase();
  }
  if (entries) {
    const entryWithCcy = entries.find((e) => e?.position_id === pos?.id && e?.currency);
    if (entryWithCcy && typeof entryWithCcy.currency === 'string' && entryWithCcy.currency.trim()) {
      return entryWithCcy.currency.trim().toUpperCase();
    }
  }
  return fallbackCurrency;
}

/**
 * Short human label for the primary entry type causing a cash leg.
 */
export function getPrimaryTypeLabel(entryType: string): string {
  const spec = entryTypeSpec(entryType);
  if (spec?.shortLabel) return spec.shortLabel;
  if (spec?.label) return spec.label;
  if (entryType === 'paid_in') return 'Paid-in';
  if (entryType === 'buy') return 'Buy';
  if (entryType === 'sell') return 'Sell';
  if (entryType === 'distribution') return 'Distribution';
  if (entryType === 'expense') return 'Expense';
  if (entryType === 'income') return 'Income';
  if (entryType === 'redemption') return 'Redemption';
  if (entryType === 'unit_transfer') return 'Unit transfer';
  if (entryType === 'commitment') return 'Commitment';
  if (entryType === 'commitment_transfer') return 'Commitment transfer';
  if (entryType === 'adjustment') return 'Adjustment';
  return entryType;
}

/**
 * Describes why a cash movement occurred by resolving the primary entry's context.
 */
export function describePrimaryDetail(
  primary: CashEntryParam,
  positionsById: Map<string, CashPositionParam>,
  entityNames?: Map<string, string> | Record<string, string>,
  cashPos?: CashPositionParam,
): string {
  const primaryPos = positionsById.get(primary.position_id);

  const getNameFromMap = (id: string | null | undefined): string | null => {
    if (!id || !entityNames) return null;
    if (entityNames instanceof Map) return entityNames.get(id) ?? null;
    return entityNames[id] ?? null;
  };

  const extPrimary = primary as CashEntryParam & {
    target_name?: string;
    asset_name?: string;
    assetName?: string;
    investor_name?: string;
    investorName?: string;
    fund_name?: string;
    fundName?: string;
    asset?: { name?: string };
    fund?: { name?: string };
    investor?: { name?: string };
    holder_investor?: { name?: string };
    holder_fund?: { name?: string };
  };

  const extPrimaryPos = primaryPos as Record<string, any> | undefined;

  const assetName =
    extPrimaryPos?.asset?.name ||
    extPrimary.asset?.name ||
    extPrimary.asset_name ||
    extPrimary.assetName ||
    getNameFromMap(primaryPos?.asset_id) ||
    extPrimary.target_name ||
    null;

  const holderInvestorName =
    extPrimaryPos?.holder_investor?.name ||
    extPrimary.holder_investor?.name ||
    extPrimary.investor?.name ||
    extPrimary.investor_name ||
    extPrimary.investorName ||
    getNameFromMap(primaryPos?.holder_investor_id) ||
    null;

  const holderFundName =
    extPrimaryPos?.holder_fund?.name ||
    extPrimary.holder_fund?.name ||
    getNameFromMap(primaryPos?.holder_fund_id) ||
    null;

  const holderName = holderInvestorName || holderFundName;

  const targetFundName =
    extPrimaryPos?.fund?.name ||
    extPrimary.fund?.name ||
    extPrimary.fund_name ||
    extPrimary.fundName ||
    getNameFromMap(primaryPos?.fund_id) ||
    null;

  let isFoF: boolean;
  if (
    cashPos?.holder_fund_id &&
    primaryPos?.fund_id &&
    cashPos.holder_fund_id === primaryPos.fund_id
  ) {
    isFoF = false;
  } else if (
    cashPos &&
    cashPos.holder_fund_id &&
    cashPos.holder_fund_id === primaryPos?.holder_fund_id
  ) {
    isFoF = Boolean((primaryPos?.fund_id || primaryPos?.fund) && !primaryPos?.asset_id && !primaryPos?.asset);
  } else {
    isFoF = Boolean(
      ((primaryPos?.holder_fund_id || primaryPos?.holder_investor_id) &&
        (primaryPos?.fund_id || primaryPos?.fund) &&
        !primaryPos?.asset_id &&
        !primaryPos?.asset) ||
      (!primaryPos?.holder_investor_id &&
        !primaryPos?.holder_investor &&
        !holderInvestorName &&
        (primaryPos?.fund_id || primaryPos?.fund || extPrimary.fund_name || extPrimary.fund))
    );
  }

  const type = primary.entry_type;
  const isRetained =
    primary.sub_type === SUB_TYPE_DIVESTMENT_CASH_IN_FUND ||
    primary.sub_type === 'cash_in_fund' ||
    primary.sub_type === 'retained';

  if (type === 'buy') {
    return assetName ? `Buy · ${assetName}` : 'Buy';
  }
  if (type === 'sell') {
    const prefix = isRetained ? 'Sell (retained)' : 'Sell';
    return assetName ? `${prefix} · ${assetName}` : prefix;
  }
  if (type === 'paid_in') {
    if (isFoF) {
      return targetFundName ? `Investment → ${targetFundName}` : 'Investment';
    }
    return holderName ? `Paid-in ← ${holderName}` : 'Paid-in';
  }
  if (type === 'distribution') {
    if (isFoF) {
      return targetFundName ? `Distribution ← ${targetFundName}` : 'Distribution';
    }
    return holderName ? `Distribution → ${holderName}` : 'Distribution';
  }
  if (type === 'redemption') {
    if (isFoF) {
      return targetFundName ? `Redemption ← ${targetFundName}` : 'Redemption';
    }
    return holderName ? `Redemption → ${holderName}` : 'Redemption';
  }
  if (type === 'expense') {
    if (primary.sub_type) return `Expense · ${primary.sub_type}`;
    if (assetName) return `Expense · ${assetName}`;
    return 'Expense';
  }
  if (type === 'income') {
    if (assetName) return `Income · ${assetName}`;
    if (primary.sub_type) return `Income · ${primary.sub_type}`;
    return 'Income';
  }

  // Fallback to entry type label + name, or label alone
  const label = getPrimaryTypeLabel(type);
  const name = assetName || holderName || (isFoF ? targetFundName : null);
  return name ? `${label} · ${name}` : label;
}

/**
 * Builds per-currency cash movement rows and running balances for a fund's cash positions.
 *
 * @param cashPositions Cash positions belonging to the fund.
 * @param entries All ledger entries (or portfolio entries including primary entries).
 * @param opts Options including `asOfDate`, `positions`, and entity name map.
 */
export function buildCashHistoryRows(
  cashPositions: CashPositionParam[],
  entries: CashEntryParam[],
  opts?: BuildCashHistoryOptions,
): CashHistoryCurrencyGroup[] {
  if (!cashPositions || cashPositions.length === 0) {
    return [];
  }

  // Filter to cash positions
  const effectiveCashPositions = cashPositions.filter(
    (p) => (!p.asset && !p.fund_id) || p.asset?.asset_kind === 'cash',
  );

  if (effectiveCashPositions.length === 0) {
    return [];
  }

  // Index positions
  const positionsById = new Map<string, CashPositionParam>();
  if (Array.isArray(opts?.positions)) {
    for (const p of opts.positions) {
      if (p?.id) positionsById.set(p.id, p);
    }
  }
  for (const p of cashPositions) {
    if (p?.id && !positionsById.has(p.id)) {
      positionsById.set(p.id, p);
    }
  }

  // Map each cash position to its currency and record all active currencies
  const cashPosCurrencyMap = new Map<string, string>();
  const allCurrencies = new Set<string>();

  for (const pos of effectiveCashPositions) {
    const ccy = resolveCashPositionCurrency(pos, entries);
    cashPosCurrencyMap.set(pos.id, ccy);
    allCurrencies.add(ccy);
  }

  // Index all entries by id for primary resolution
  const entriesById = new Map<string, CashEntryParam>();
  if (Array.isArray(entries)) {
    for (const e of entries) {
      if (e?.id) {
        entriesById.set(e.id, e);
      }
    }
  }

  // Group cash movement entries on these cash positions by currency
  const cashPosIdSet = new Set(effectiveCashPositions.map((p) => p.id));
  const entriesByCurrency = new Map<string, CashEntryParam[]>();

  if (Array.isArray(entries)) {
    for (const entry of entries) {
      if (!entry?.position_id || !cashPosIdSet.has(entry.position_id)) {
        continue;
      }

      // As-of date filter: entry_date <= asOfDate
      if (opts?.asOfDate && entry.entry_date && entry.entry_date > opts.asOfDate) {
        continue;
      }

      const ccy =
        (typeof entry.currency === 'string' && entry.currency.trim())
          ? entry.currency.trim().toUpperCase()
          : (cashPosCurrencyMap.get(entry.position_id) || 'USD');

      allCurrencies.add(ccy);

      const list = entriesByCurrency.get(ccy);
      if (list) {
        list.push(entry);
      } else {
        entriesByCurrency.set(ccy, [entry]);
      }
    }
  }

  // Build rows for each currency in stable alphabetical order
  const sortedCurrencies = Array.from(allCurrencies).sort((a, b) => a.localeCompare(b));
  const result: CashHistoryCurrencyGroup[] = [];

  for (const currency of sortedCurrencies) {
    const currencyEntries = entriesByCurrency.get(currency) || [];

    // Same ordering rule as the ledger sheet: entry_date, then the moment the
    // row was recorded, then the id. The running balance below accumulates in
    // exactly this order, so a same-day tie decided differently here than on
    // the sheet would show two different balances for the same rows.
    //
    // An opening balance is pinned ahead of anything it shares a date with: it
    // is what the account held before the day's movements, whatever order it
    // was actually recorded in. A backfilled one is typed in after the
    // movements it precedes, so `created_at` alone would drop it mid-table and
    // start the running balance from the wrong row.
    currencyEntries.sort((a, b) => {
      const byDate = (a.entry_date ?? '').localeCompare(b.entry_date ?? '');
      if (byDate !== 0) return byDate;
      const byOpening =
        Number(b.sub_type === 'opening_balance') - Number(a.sub_type === 'opening_balance');
      if (byOpening !== 0) return byOpening;
      return compareLedgerRowsOldestFirst(a, b);
    });

    let runningBalance = '0.00000000';
    const rows: CashHistoryRow[] = [];

    for (const entry of currencyEntries) {
      const rawDelta = entry.cash_delta != null ? String(entry.cash_delta) : '0';
      const amount = toDecimalString(rawDelta);
      runningBalance = flAdd(runningBalance, amount);

      const isOpeningBalance = entry.sub_type === 'opening_balance';
      const isReversal = Boolean(entry.is_reversal);

      let typeLabel = 'Cash movement';
      let detail = 'Cash movement';

      if (isOpeningBalance) {
        typeLabel = 'Opening balance';
        detail = 'Opening balance';
      } else if (!entry.source_ledger_entry_id && entry.counterparty_position_id) {
        // FX transfer
        typeLabel = 'FX transfer';
        let cpCurrency: string | undefined;
        const cpPos = positionsById.get(entry.counterparty_position_id);
        if (cpPos) {
          cpCurrency = resolveCashPositionCurrency(cpPos, entries);
        }
        if (!cpCurrency && Array.isArray(entries)) {
          const sibling = entries.find(
            (e) =>
              (e.position_id === entry.counterparty_position_id || e.id === entry.counterparty_position_id) &&
              e.currency &&
              e.currency !== currency,
          );
          if (sibling?.currency) {
            cpCurrency = sibling.currency;
          }
        }
        detail = cpCurrency ? `FX transfer · ${cpCurrency}` : 'FX transfer';
      } else if (entry.source_ledger_entry_id) {
        const primary = entriesById.get(entry.source_ledger_entry_id);
        if (!primary) {
          // Primary entry missing: graceful fallback
          typeLabel = 'Cash movement';
          detail = 'Cash movement';
        } else {
          typeLabel = getPrimaryTypeLabel(primary.entry_type);
          const currentCashPos = entry.position_id ? positionsById.get(entry.position_id) : undefined;
          detail = describePrimaryDetail(primary, positionsById, opts?.entityNames, currentCashPos);
        }
      }

      rows.push({
        id: entry.id,
        date: entry.entry_date || '',
        typeLabel,
        detail,
        amount,
        runningBalance,
        notes: entry.notes ?? null,
        isReversal,
        isOpeningBalance,
      });
    }

    result.push({
      currency,
      rows,
      closingBalance: runningBalance,
    });
  }

  return result;
}
