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
