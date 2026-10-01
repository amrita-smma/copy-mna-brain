import { isPaidInAdjustment } from '@/lib/fundLedger/paidInAdjustment';
import { flIsZero, flAbs, flNeg, toDecimalString, toExactDecimalString } from '@/lib/services/flDecimal';
import type { ParsedTxn, ParsedValuation } from './parsers/startech_quarterly';
import { classifyFundUpdateTxn } from './canonicalEvent';

/**
 * Key kind for a transferee-only commitment transfer: a `commitment` entry
 * tagged `sub_type = 'transfer_in'`, or the positive leg of a two-legged
 * `commitment_transfer` posted by an earlier import. Kept apart from ordinary
 * commitment increases so a same-day, same-amount increase never dedups
 * against a transfer.
 */
const TRANSFER_IN_KEY_KIND = 'commitment_transfer_in';

/**
 * Stable dedup key for one-sided commitment event proposals and ledger entries.
 * Format: `${entryType}|${date}|${keyAmount}`
 * where entryType is 'commitment', 'commitment_transfer_in', 'paid_in', or
 * 'distribution', and keyAmount is:
 * - signed exact decimal string for commitment (negative for decrease)
 * - positive exact decimal string for transfer_in, paid_in and distribution
 */
export function buildCommitmentEventDedupKey(
  intent: 'increase' | 'decrease' | 'transfer_in' | 'paid_in' | 'distribution' | string,
  date: string,
  amount: number | string,
): string {
  if (intent === 'transfer_in') {
    return `${TRANSFER_IN_KEY_KIND}|${date}|${flAbs(toExactDecimalString(amount))}`;
  }
  const entryType =
    intent === 'paid_in'
      ? 'paid_in'
      : intent === 'distribution'
        ? 'distribution'
        : 'commitment';
  const amtStr = flAbs(toExactDecimalString(amount));
  const keyAmount =
    entryType === 'commitment' && intent === 'decrease'
      ? flNeg(amtStr)
      : amtStr;
  return `${entryType}|${date}|${keyAmount}`;
}

/**
 * Builds dedup key from an existing database ledger entry.
 */
export function buildLedgerEntryCommitmentDedupKey(entry: {
  entry_type: string;
  entry_date: string;
  commitment_delta?: string | null;
  cash_delta?: string | null;
  valuation_delta?: string | null;
  sub_type?: string | null;
}): string {
  if (isPaidInAdjustment(entry)) {
    return buildAdjustmentDedupKey(entry.entry_date, '0.00000000', entry.commitment_delta ?? '0.00000000', entry.valuation_delta ?? '0');
  }
  const commitmentDelta = toExactDecimalString(entry.commitment_delta ?? '0.00000000');
  const isTransferIn =
    (entry.entry_type === 'commitment' && entry.sub_type === 'transfer_in') ||
    (entry.entry_type === 'commitment_transfer' && !commitmentDelta.startsWith('-') && !flIsZero(commitmentDelta));
  if (isTransferIn) {
    return `${TRANSFER_IN_KEY_KIND}|${entry.entry_date}|${flAbs(commitmentDelta)}`;
  }
  const amount =
    entry.entry_type === 'commitment'
      ? entry.commitment_delta
      : entry.entry_type === 'adjustment'
        ? `${entry.valuation_delta}:${entry.commitment_delta}`
        : entry.cash_delta;
  const normalized =
    entry.entry_type === 'commitment'
      ? toExactDecimalString(amount ?? '0.00000000')
      : entry.entry_type === 'adjustment'
        ? (amount ?? '0.00000000:0.00000000')
        : toExactDecimalString(flAbs(amount ?? '0.00000000'));
  return `${entry.entry_type}|${entry.entry_date}|${normalized}`;
}

/**
 * Stable dedup key for commitment transfers.
 * Format: `commitment_transfer|${date}|${amount}|${transferorPositionId}|${transfereePositionId}`
 */
export function buildCommitmentTransferDedupKey(
  date: string,
  amount: number | string,
  transferorPositionId: string,
  transfereePositionId: string,
): string {
  const amtStr = toExactDecimalString(flAbs(toExactDecimalString(amount)));
  return `commitment_transfer|${date}|${amtStr}|${transferorPositionId}|${transfereePositionId}`;
}

/**
 * Decides whether a transferee-only transfer row is already in the ledger.
 *
 * The posted entry carries no transferor, so the ledger can only be matched by
 * `(transferee position, date, amount)`. Two different transferors handing the
 * same amount to one holder on one day are two rows, so each matching ledger
 * entry absorbs at most one row, while a row repeated with the same transferor
 * within one batch is a duplicate.
 */
export class TransferInReplayGuard {
  private readonly batchRows = new Set<string>();
  private readonly ledgerMatches = new Map<string, number>();
  private readonly absorbed = new Map<string, number>();

  /**
   * @param ledgerMatchCount entries on the position with this dedup key. Read
   *   once per `(position, key)` on first sight, before this batch posts any.
   * @returns `'duplicate'` when the row is already recorded, `'new'` to post it.
   */
  check(
    positionKey: string,
    dedupKey: string,
    transferorKey: string,
    ledgerMatchCount: number,
  ): 'duplicate' | 'new' {
    const slot = `${positionKey}|${dedupKey}`;
    if (!this.ledgerMatches.has(slot)) this.ledgerMatches.set(slot, ledgerMatchCount);

    const row = `${slot}|${transferorKey}`;
    if (this.batchRows.has(row)) return 'duplicate';
    this.batchRows.add(row);

    const absorbed = this.absorbed.get(slot) ?? 0;
    if (absorbed < (this.ledgerMatches.get(slot) ?? 0)) {
      this.absorbed.set(slot, absorbed + 1);
      return 'duplicate';
    }
    return 'new';
  }
}

/**
 * Stable dedup key for non-cash adjustments.
 * Format: `adjustment|${date}|${valuationDelta}:${commitmentDelta}`
 */
export function buildAdjustmentDedupKey(
  date: string,
  valuationDelta: string,
  commitmentDelta = '0.00000000',
  paidInAdjustmentDelta = '0.00000000',
): string {
  const base = `adjustment|${date}|${valuationDelta}:${commitmentDelta}`;
  return flIsZero(paidInAdjustmentDelta) ? base : `${base}:paid_in:${toExactDecimalString(paidInAdjustmentDelta)}`;
}

/**
 * Decimal scale used by the fund ledger storage columns in Postgres.
 * Matches `numeric(38, 8)` for `fl_ledger_entries.price_per_unit`,
 * `quantity_delta`, and `cash_delta` in `schema.ts`.
 */
export const LEDGER_DECIMAL_SCALE = 8;

export function normalizeTxnKeyType(raw: string | null | undefined): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'other' || lower === 'others') return 'other';
  if (
    lower === 'buy' ||
    lower === 'paid_in' ||
    lower === 'contribution' ||
    lower === 'investment' ||
    lower === 'asset_investment' ||
    lower === 'capital_call' ||
    lower === 'capital_contribution' ||
    lower === 'cost of investment'
  ) {
    return 'contribution';
  }
  if (
    lower === 'sell' ||
    lower === 'divestment' ||
    lower === 'exit' ||
    lower === 'asset_exit' ||
    lower === 'redemption'
  ) {
    return 'divestment';
  }
  if (
    lower === 'interest' ||
    lower === 'interest_income' ||
    lower === 'interest income'
  ) {
    return 'interest_income';
  }
  if (lower === 'dividend') return 'dividend';
  if (lower === 'return_of_capital' || lower === 'return of capital') return 'return_of_capital';
  if (lower === 'distribution' || lower === 'investor_distribution') return 'distribution';
  if (
    lower === 'expense' ||
    lower === 'expenses' ||
    lower === 'fee' ||
    lower === 'fees'
  ) {
    return 'expense';
  }
  if (lower === 'management_fee' || lower === 'management fee') return 'management_fee';
  return trimmed;
}

/** Stable dedup key for fund-update transactions (matches apply service). */
export function fundUpdateTxnKey(t: {
  date?: string | null;
  txn_date?: string | null;
  type?: string | null;
  txn_type?: string | null;
  valueAmount?: number | string | null;
  value_amount?: number | string | null;
  shareCount?: number | string | null;
  share_count?: number | string | null;
  pricePerShare?: number | string | null;
  price_per_share?: number | string | null;
  currency?: string | null;
  notes?: string | null;
  subTypeLabel?: string | null;
  sub_type?: string | null;
  sellProceedsDestination?: string | null;
  sell_proceeds_destination?: string | null;
}): string {
  const date = t.date ?? t.txn_date ?? '';
  const rawType = t.type ?? t.txn_type ?? '';
  const notes = t.notes ?? '';
  const subType = t.subTypeLabel ?? t.sub_type ?? '';

  let type = normalizeTxnKeyType(rawType);
  if (type === 'other') {
    const classification = classifyFundUpdateTxn({
      type: rawType,
      subTypeLabel: subType,
      notes,
      valueAmount: t.valueAmount ?? t.value_amount,
      shareCount: t.shareCount ?? t.share_count,
      pricePerShare: t.pricePerShare ?? t.price_per_share,
    });
    if (!classification.isEstimated && !classification.isUnresolved) {
      if (classification.canonicalKind === 'expense') {
        type = classification.subType === 'management_fee' ? 'management_fee' : 'expense';
      } else if (classification.canonicalKind === 'income') {
        type =
          classification.subType === 'dividend'
            ? 'dividend'
            : classification.subType === 'interest_income' || classification.subType === 'interest'
            ? 'interest_income'
            : 'income';
      }
    }
  }


  const canonicalDecimal = (
    value: number | string | null | undefined,
    options?: { unsigned?: boolean },
  ): string => {
    if (value == null || value === '') return '';
    const raw = String(value).trim();
    if (!/^-?\d+(?:\.\d+)?$/.test(raw)) return raw;
    const quantized = toDecimalString(raw, LEDGER_DECIMAL_SCALE);
    const negative = quantized.startsWith('-');
    const unsigned = negative ? quantized.slice(1) : quantized;
    const [whole, fraction = ''] = unsigned.split('.');
    const normalizedWhole = whole.replace(/^0+(?=\d)/, '') || '0';
    const normalizedFraction = fraction.replace(/0+$/, '');
    const isZero = normalizedWhole === '0' && !normalizedFraction;
    if (isZero) return '0';
    const isNegative = !options?.unsigned && negative;
    return `${isNegative ? '-' : ''}${normalizedWhole}${normalizedFraction ? `.${normalizedFraction}` : ''}`;
  };

  const unsignedVal = canonicalDecimal(t.valueAmount ?? t.value_amount, { unsigned: true });
  const isExpenseType = type === 'expense' || type === 'management_fee';
  const preserveSign = type === 'other';
  const value = isExpenseType
    ? (unsignedVal && unsignedVal !== '0' ? `-${unsignedVal}` : unsignedVal)
    : canonicalDecimal(t.valueAmount ?? t.value_amount, { unsigned: !preserveSign });

  // The ledger represents an untracked quantity as zero while workbook
  // parsers represent it as null; both mean value-only for replay purposes.
  const canonicalShares = canonicalDecimal(t.shareCount ?? t.share_count, { unsigned: true });
  const shares = canonicalShares === '0' ? '' : canonicalShares;
  const pps = canonicalDecimal(t.pricePerShare ?? t.price_per_share);
  const currency = t.currency ? t.currency.trim().toUpperCase() : '';
  const baseKey = `${date}|${type}|${value}|${shares}|${pps}`;
  // Proceeds treatment is deliberately NOT part of the identity key. Phase 1 established
  // that a retained and a distributed sale of the same date/amount/currency are the SAME
  // economic event, so a changed destination is reported as a conflict to explain rather
  // than posted as a second event. See phase1ReviewBoundary.test.ts R4 and Criterion 20.
  return currency ? `${baseKey}|${currency}` : baseKey;
}

export function fundUpdateValKey(v: Pick<ParsedValuation, 'asOfDate'>): string {
  return v.asOfDate;
}

/** Stable dedup key for investor commitment events (matches apply service). */
export function commitmentEventKey(e: {
  date?: string | null;
  effective_date?: string | null;
  event_type?: string | null;
  amount?: number | null;
}): string {
  const date = e.date ?? e.effective_date ?? '';
  const eventType = e.event_type ?? '';
  const amount = e.amount ?? '';
  return `${date}|${eventType}|${amount}`;
}

/** Stable key for proposed review commitment events. */
export function reviewCommitmentEventKey(e: {
  fund: string;
  investorName: string;
  date: string;
  intent: string;
  amount: number;
  sourceRow: number;
}): string {
  const fund = e.fund.trim().toLowerCase();
  const investor = e.investorName.trim().toLowerCase();
  return `${fund}|${investor}|${e.date}|${e.intent}|${e.amount}|${e.sourceRow}`;
}

export function defaultCommitmentEventSelection(
  events?: Array<{ key: string; status: 'actionable' | 'duplicate' }>,
): Set<string> {
  if (!events) return new Set();
  return new Set(events.filter((e) => e.status === 'actionable').map((e) => e.key));
}

/** Helper to filter review commitment events for a specific investor. */
export function filterCommitmentEventsByInvestor<
  T extends { event: { investorName: string } },
>(events: T[], investorName: string): T[] {
  const target = investorName.trim().toLowerCase();
  return events.filter((e) => e.event.investorName.trim().toLowerCase() === target);
}

export function setInvestorCommitmentEventSelection<
  T extends { key: string; status: 'actionable' | 'duplicate'; event: { investorName: string } },
>(current: Set<string>, events: T[], investorName: string, selected: boolean): Set<string> {
  const next = new Set(current);
  for (const event of filterCommitmentEventsByInvestor(events, investorName)) {
    if (!selected) {
      next.delete(event.key);
      continue;
    }
    if (event.status === 'actionable') next.add(event.key);
  }
  return next;
}

export type FundUpdateAssetStatus = 'new' | 'unchanged' | 'add_missing';

const STATUS_SORT_ORDER: Record<FundUpdateAssetStatus, number> = {
  new: 0,
  add_missing: 1,
  unchanged: 2,
};

/** Sort review assets: New → Add missing → Unchanged, then by code. */
export function sortFundUpdateReviewAssets<T extends { status: FundUpdateAssetStatus; code: string }>(
  assets: T[],
): T[] {
  return [...assets].sort((a, b) => {
    const byStatus = STATUS_SORT_ORDER[a.status] - STATUS_SORT_ORDER[b.status];
    return byStatus !== 0 ? byStatus : a.code.localeCompare(b.code);
  });
}
