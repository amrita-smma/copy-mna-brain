import type { ParsedTxn, ParsedValuation } from './parsers/startech_quarterly';

/** Stable dedup key for fund-update transactions (matches apply service). */
export function fundUpdateTxnKey(t: {
  date?: string | null;
  txn_date?: string | null;
  type?: string | null;
  txn_type?: string | null;
  valueAmount?: number | null;
  value_amount?: number | null;
  shareCount?: number | null;
  share_count?: number | null;
  pricePerShare?: number | null;
  price_per_share?: number | null;
}): string {
  const date = t.date ?? t.txn_date ?? '';
  const type = t.type ?? t.txn_type ?? '';
  const value = t.valueAmount ?? t.value_amount ?? '';
  const shares = t.shareCount ?? t.share_count ?? '';
  const pps = t.pricePerShare ?? t.price_per_share ?? '';
  return `${date}|${type}|${value}|${shares}|${pps}`;
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
