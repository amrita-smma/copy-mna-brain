/**
 * Managed-fund ↔ managed-fund flows in a Nanjing lifecycle ledger.
 *
 * When one managed fund invests in another, the workbook records the same money
 * twice, once in each fund's book:
 * - the payer's book: 投资 (investment) / 退出 (exit proceeds) into the target fund;
 * - the receiver's book: 实缴 (paid-in) / 分配 (distribution) from the holder fund.
 *
 * The receiving fund's book is authoritative. Its commitment-path rows post on
 * the fund-held position {holder_fund_id: holder, fund_id: target}, which yields
 * both cash legs in one entry. The payer's 投资/退出 rows post no ledger entry
 * and stay visible in review with an annotation.
 *
 * Detection is an exact canonical-name match against the managed fund catalog.
 * No substring, prefix, or fuzzy matching: a management company such as
 * 南京金光紫金创业投资管理有限公司 is an outside investor, not the fund
 * 南京金光紫金股权投资基金.
 */
import { normalizeCanonicalName } from '@/lib/fundLedger/normalizeIdentity';
import type { ParsedAsset, ParsedTxn } from './parsers/startech_quarterly';
import type { ParsedCommitmentEvent } from './parsers/nanjing_fund_ledger';

/** First-row date gap (in days) between the two books that triggers a warning. */
export const MANAGED_FUND_CROSS_BOOK_DATE_GAP_DAYS = 90;

/** Canonical keys for a set of managed fund names. Empty names are dropped. */
export function buildManagedFundNameKeys(
  names: Iterable<string | null | undefined>,
): Set<string> {
  const keys = new Set<string>();
  for (const name of names) {
    const key = normalizeCanonicalName(name);
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * True when `name` is exactly one of the managed funds, after the bilingual split
 * and canonical normalization. An English suffix on the same line is ignored.
 */
export function isManagedFundName(
  name: string | null | undefined,
  managedKeys: ReadonlySet<string>,
): boolean {
  const key = normalizeCanonicalName(name);
  return key !== '' && managedKeys.has(key);
}

/**
 * True for a fund-held proposal whose holder fund and target fund are both
 * managed and distinct: its 投资/退出 rows are recorded from the target's book.
 */
export function isManagedFundCrossBookAsset(
  asset: Pick<ParsedAsset, 'fund' | 'name' | 'holderKind'>,
  managedKeys: ReadonlySet<string>,
): boolean {
  if (asset.holderKind === 'investor') return false;
  const holderKey = normalizeCanonicalName(asset.fund);
  const targetKey = normalizeCanonicalName(asset.name);
  return (
    holderKey !== '' &&
    targetKey !== '' &&
    holderKey !== targetKey &&
    managedKeys.has(holderKey) &&
    managedKeys.has(targetKey)
  );
}

export type CrossBookFlowKind = 'paid_in' | 'distribution';

/** Which of the receiving fund's rows record a payer-side txn. */
export function crossBookFlowKindForTxn(txn: Pick<ParsedTxn, 'type'>): CrossBookFlowKind {
  return txn.type === 'divestment' ? 'distribution' : 'paid_in';
}

const FLOW_LABEL: Record<CrossBookFlowKind, string> = {
  paid_in: 'paid-in',
  distribution: 'distribution',
};

/** Review / outcome annotation for a payer-side row that posts nothing. */
export function managedFundCrossBookNote(
  targetFund: string,
  kind: CrossBookFlowKind = 'paid_in',
): string {
  return `Recorded from ${targetFund}'s ${FLOW_LABEL[kind]} rows; this row posts no ledger entry.`;
}

/** 万元 display used in warnings, e.g. 29000000 -> "2,900万". */
export function formatWan(amount: number): string {
  const wan = Math.round((amount / 10_000) * 10_000) / 10_000;
  return `${wan.toLocaleString('en-US', { maximumFractionDigits: 4 })}万`;
}

export interface ManagedFundCrossBookPair {
  kind: CrossBookFlowKind;
  holderFund: string;
  targetFund: string;
  /** Payer-side (投资 / 退出) total in CNY and its source rows. */
  payerTotal: number;
  payerRows: number[];
  payerFirstDate: string | null;
  /** Receiver-side (实缴 / 分配) total in CNY and its source rows. */
  receiverTotal: number;
  receiverRows: number[];
  receiverFirstDate: string | null;
}

const minDate = (a: string | null, b: string | null): string | null => {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
};

/**
 * Groups the payer-side and receiver-side rows of every managed → managed pair.
 * Totals are compared per (kind, holder fund, target fund); rows are never
 * matched one-to-one, because the two books may split the same money differently
 * (e.g. one 400万 投资 against 300万 + 100万 实缴).
 */
export function summarizeManagedFundCrossBook(
  assets: ParsedAsset[],
  events: ParsedCommitmentEvent[],
  managedKeys: ReadonlySet<string>,
): ManagedFundCrossBookPair[] {
  const pairs = new Map<string, ManagedFundCrossBookPair>();
  const pairFor = (kind: CrossBookFlowKind, holderFund: string, targetFund: string) => {
    const key = `${kind}|${normalizeCanonicalName(holderFund)}|${normalizeCanonicalName(targetFund)}`;
    let pair = pairs.get(key);
    if (!pair) {
      pair = {
        kind,
        holderFund,
        targetFund,
        payerTotal: 0,
        payerRows: [],
        payerFirstDate: null,
        receiverTotal: 0,
        receiverRows: [],
        receiverFirstDate: null,
      };
      pairs.set(key, pair);
    }
    return pair;
  };

  for (const asset of assets) {
    if (!isManagedFundCrossBookAsset(asset, managedKeys)) continue;
    for (const txn of asset.txns) {
      if (txn.type !== 'contribution' && txn.type !== 'divestment') continue;
      const amount = Math.abs(txn.valueAmount ?? 0);
      if (amount === 0) continue;
      const pair = pairFor(crossBookFlowKindForTxn(txn), asset.fund, asset.name);
      pair.payerTotal += amount;
      if (txn.sourceRow != null) pair.payerRows.push(txn.sourceRow);
      pair.payerFirstDate = minDate(pair.payerFirstDate, txn.date || null);
    }
  }

  for (const event of events) {
    if (event.intent !== 'paid_in' && event.intent !== 'distribution') continue;
    if (!isManagedFundName(event.investorName, managedKeys)) continue;
    if (normalizeCanonicalName(event.investorName) === normalizeCanonicalName(event.fund)) continue;
    const pair = pairFor(event.intent, event.investorName, event.fund);
    pair.receiverTotal += Math.abs(event.amount);
    pair.receiverRows.push(event.sourceRow);
    pair.receiverFirstDate = minDate(pair.receiverFirstDate, event.date || null);
  }

  return [...pairs.values()];
}

const daysBetween = (a: string, b: string): number =>
  Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);

const rowList = (rows: number[]): string =>
  rows.length > 0 ? ` (row${rows.length > 1 ? 's' : ''} ${rows.join(', ')})` : '';

/**
 * Non-blocking reconciliation warnings for one pair: totals differ, one side is
 * absent, or the two books' first rows are far apart in time.
 */
export function managedFundCrossBookWarnings(
  pair: ManagedFundCrossBookPair,
  dateGapDays: number = MANAGED_FUND_CROSS_BOOK_DATE_GAP_DAYS,
): string[] {
  const payerLabel = pair.kind === 'paid_in' ? '投资' : '退出';
  const receiverLabel = pair.kind === 'paid_in' ? '实缴' : '分配';
  const head = `${pair.holderFund} → ${pair.targetFund}`;
  const warnings: string[] = [];

  if (pair.receiverRows.length === 0) {
    warnings.push(
      `${head}: ${formatWan(pair.payerTotal)} ${payerLabel} in ${pair.holderFund}'s book${rowList(pair.payerRows)} has no ${receiverLabel} rows in ${pair.targetFund}'s book; it is recorded only from ${pair.targetFund}'s book, so nothing is posted for it yet.`,
    );
    return warnings;
  }
  if (pair.payerRows.length === 0) {
    warnings.push(
      `${head}: ${formatWan(pair.receiverTotal)} ${receiverLabel} in ${pair.targetFund}'s book${rowList(pair.receiverRows)} has no matching ${payerLabel} rows in ${pair.holderFund}'s book.`,
    );
    return warnings;
  }
  if (Math.abs(pair.payerTotal - pair.receiverTotal) >= 0.01) {
    warnings.push(
      `${head}: ${payerLabel} total ${formatWan(pair.payerTotal)}${rowList(pair.payerRows)} does not match ${receiverLabel} total ${formatWan(pair.receiverTotal)}${rowList(pair.receiverRows)}; ${pair.targetFund}'s book is posted.`,
    );
  }
  if (pair.payerFirstDate && pair.receiverFirstDate) {
    const gap = daysBetween(pair.payerFirstDate, pair.receiverFirstDate);
    if (gap > dateGapDays) {
      warnings.push(
        `${head}: first ${payerLabel} row is dated ${pair.payerFirstDate} but first ${receiverLabel} row is dated ${pair.receiverFirstDate} (${gap} days apart); check the dates in both books.`,
      );
    }
  }
  return warnings;
}
