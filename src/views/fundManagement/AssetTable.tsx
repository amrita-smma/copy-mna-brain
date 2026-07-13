'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { Fund, Holding } from './types';
import {
  getAssetEntity,
  getAssetFundingSources,
  getAssetInvestType,
  money,
  sliceHoldingsByTxn,
  type HoldingSlice,
} from './calc';
import { Chevron, DeleteRowMenu, GlossaryTerm, Pill } from './parts';
import { HoldingDetail } from './HoldingDetail';
import { TablePager } from './TablePager';
import { useFundData } from './context';

const PAGE_SIZE = 25;

type GroupBy = 'none' | 'fund' | 'investor' | 'source';

const GROUP_OPTIONS: { k: GroupBy; label: string }[] = [
  { k: 'none', label: 'No grouping' },
  { k: 'fund', label: 'by Fund Type' },
  { k: 'investor', label: 'by Investor' },
  { k: 'source', label: 'by Source of Fund' },
];

const GROUP_HEAD: Record<Exclude<GroupBy, 'none'>, string> = {
  fund: 'Fund Type',
  investor: 'Investor',
  source: 'Source of Fund',
};

const HOLDING_TYPE_NAME: Record<string, string> = {
  Equity: 'Company',
  Cash: 'Cash',
  Obligation: 'Loan',
  Shares: 'Public shares',
  'Fund of funds': 'Fund',
};
const TYPE_TERM: Record<string, string> = {
  Equity: 'equity',
  Cash: 'cash',
  Obligation: 'obligation',
  Shares: 'shares',
  'Fund of funds': 'fof',
};

/** The shared asset-row column labels (right-aligned metric columns). */
const ASSET_COLS: { label: string; term?: string }[] = [
  { label: 'Invested', term: 'deployed' },
  { label: 'Unrealized MV', term: 'currentvalue' },
  { label: 'MOIC', term: 'returnmult' },
  { label: 'Realized Value', term: 'cashreturned' },
  { label: 'DPI', term: 'dpiT' },
];

const dpi = (cost: number, real: number) => (cost > 0 ? real / cost : 0);

/**
 * The "Asset" tab: every holding across all funds, optionally grouped by fund
 * type / investor / source of fund. Ungrouped, each asset row expands to its
 * full HoldingDetail (Performance / Company & legal / Business / Transactions /
 * Deal economics / Historical value). Grouped, a group row expands to its asset
 * rows, and each asset row expands to the same HoldingDetail.
 */
export function AssetTable({
  funds,
}: {
  funds: Fund[];
}) {
  const { deleteAsset, entityNameById, sourceNameById } = useFundData();
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [openAssets, setOpenAssets] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);

  // Grouping mode changes what a "row" is (assets vs. groups), so restart
  // paging from the first page to avoid landing on an out-of-range page.
  useEffect(() => setPage(1), [groupBy]);

  const toggle = <T,>(set: Set<T>, val: T) => {
    const next = new Set(set);
    next.has(val) ? next.delete(val) : next.add(val);
    return next;
  };

  // Every row (grouped or not) is a HoldingSlice: for "No grouping" and "by
  // Fund Type" the slice carries the whole-asset numbers; for "by Investor" and
  // "by Source of Fund" it carries only that group's transaction-level slice.
  const wholeSlice = (h: Holding, f: Fund, hi: number): HoldingSlice => ({
    h,
    f,
    hkey: `${f.id}_${hi}`,
    cost: h.cost,
    fmv: h.fmv,
    real: h.real,
    moic: h.moic,
  });

  const flat: HoldingSlice[] = funds.flatMap((f) => f.h.map((h, hi) => wholeSlice(h, f, hi)));

  const aggSlices = (items: HoldingSlice[]) => {
    let cost = 0;
    let fmv = 0;
    let real = 0;
    items.forEach((it) => {
      cost += it.cost;
      fmv += it.fmv;
      real += it.real;
    });
    return { cost, fmv, real, moic: cost > 0 ? (fmv + real) / cost : 0, count: items.length };
  };

  const buildGroups = (): Map<string, HoldingSlice[]> => {
    if (groupBy === 'fund') {
      // Fund membership is already transaction-level at load time: a
      // co-invested asset arrives once per fund, scoped to that fund's share
      // (see scopeHoldingToFund). So we just group the whole (scoped) holdings
      // by the fund they belong to.
      const map = new Map<string, HoldingSlice[]>();
      funds.forEach((f) =>
        f.h.forEach((h, hi) => {
          if (!map.has(f.n)) map.set(f.n, []);
          map.get(f.n)!.push(wholeSlice(h, f, hi));
        }),
      );
      return map;
    }
    if (groupBy === 'investor') {
      return sliceHoldingsByTxn(
        funds,
        (t, h) =>
          t.holdingEntityId
            ? entityNameById.get(t.holdingEntityId) ?? getAssetEntity(h) ?? 'Unspecified'
            : getAssetEntity(h) || 'Unspecified',
        (h) => [getAssetEntity(h) || 'Unspecified'],
      );
    }
    return sliceHoldingsByTxn(
      funds,
      (t, h) =>
        t.fundingSourceId
          ? sourceNameById.get(t.fundingSourceId) ?? getAssetFundingSources(h)[0]
          : getAssetFundingSources(h)[0],
      (h) => getAssetFundingSources(h),
    );
  };

  const groups =
    groupBy === 'none'
      ? []
      : [...buildGroups().entries()]
          .map(([name, items]) => ({ name, items, a: aggSlices(items) }))
          .sort((x, y) => y.a.fmv - x.a.fmv);

  // Paginate whichever list is being shown — flat asset rows when ungrouped,
  // group rows when grouped. Slicing the top-level rows (not the expanded
  // detail panels) keeps a heavy portfolio from rendering hundreds of rows at
  // once, complementing the batched load that removed the per-asset fetches.
  const total = groupBy === 'none' ? flat.length : groups.length;
  const start = (Math.min(page, Math.max(1, Math.ceil(total / PAGE_SIZE))) - 1) * PAGE_SIZE;
  const pagedFlat = [...flat].sort((x, y) => y.fmv - x.fmv).slice(start, start + PAGE_SIZE);
  const pagedGroups = groups.slice(start, start + PAGE_SIZE);

  // A single asset row + (if open) its detail panel. `rowKey` scopes the
  // open-state so the same holding under two source groups toggles independently.
  const assetRows = (items: HoldingSlice[], nested: boolean, scope: string): ReactNode[] => {
    const out: ReactNode[] = [];
    [...items]
      .sort((x, y) => y.fmv - x.fmv)
      .forEach(({ h, f, hkey, cost, fmv, real, moic }) => {
        const rowKey = `${scope}::${hkey}`;
        const hopen = openAssets.has(rowKey);
        out.push(
          <tr
            key={`a${rowKey}`}
            onClick={() => setOpenAssets((s) => toggle(s, rowKey))}
            className={cn(
              'cursor-pointer border-b [&>td]:bg-muted/10 hover:[&>td]:bg-background',
              hopen && '[&>td]:!bg-accent/10',
            )}
          >
            <td className="py-2 pl-3 pr-3 align-middle">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center">
                  {nested && <span className="w-5 shrink-0" />}
                  <span className="mr-2 w-3 shrink-0 text-[11px] text-muted-foreground">
                    {hopen ? '▾' : '▸'}
                  </span>
                  <div className={cn(nested && 'border-l-2 border-border pl-2.5')}>
                    <div className="text-[13px] font-medium text-foreground">{h.n}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <Pill>
                        <GlossaryTerm term={TYPE_TERM[h.tp] || 'equity'}>
                          {HOLDING_TYPE_NAME[h.tp] || h.tp}
                        </GlossaryTerm>
                      </Pill>
                      <Pill>{getAssetInvestType(h)}</Pill>
                      <span className="text-[11px] text-muted-foreground">{f.n}</span>
                      {h.dt && <span className="text-[11px] text-muted-foreground">· {h.dt}</span>}
                    </div>
                  </div>
                </div>
                {h.id && (
                  <DeleteRowMenu
                    label="Delete holding"
                    title={`Delete "${h.n}"?`}
                    description="This will permanently delete this holding and its full transaction and valuation history. This action cannot be undone."
                    onConfirm={() => deleteAsset(f, h)}
                  />
                )}
              </div>
            </td>
            <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">{money(cost)}</td>
            <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
              {fmv > 0 ? money(fmv) : '—'}
            </td>
            <td className="px-3 py-2 text-right align-middle text-[13px] font-medium text-foreground">
              {moic.toFixed(2)}×
            </td>
            <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
              {real > 0 ? money(real) : '—'}
            </td>
            <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
              {dpi(cost, real).toFixed(2)}×
            </td>
            <td className="px-3 py-2 align-middle">
              <Pill>{h.st}</Pill>
            </td>
          </tr>,
        );
        if (hopen) {
          out.push(
            <tr key={`d${rowKey}`} className="border-b">
              <td colSpan={7} className="bg-background px-3 pb-3.5 pt-2">
                <HoldingDetail fund={f} holding={h} />
              </td>
            </tr>,
          );
        }
      });
    return out;
  };

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Group:</span>
        {GROUP_OPTIONS.map(({ k, label }) => (
          <button
            key={k}
            type="button"
            onClick={() => setGroupBy(k)}
            className={cn(
              'rounded-full border px-3 py-1 text-xs',
              groupBy === k
                ? 'border-accent bg-accent text-accent-foreground'
                : 'bg-muted/60 text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[820px] border-collapse">
          <thead>
            <tr>
              <th className="whitespace-nowrap border-b bg-muted/50 px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {groupBy === 'none' ? 'Asset' : GROUP_HEAD[groupBy]}
              </th>
              {ASSET_COLS.map((c) => (
                <th
                  key={c.label}
                  className="whitespace-nowrap border-b bg-muted/50 px-3 py-2 text-right text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                >
                  {c.term ? <GlossaryTerm term={c.term}>{c.label}</GlossaryTerm> : c.label}
                </th>
              ))}
              <th className="whitespace-nowrap border-b bg-muted/50 px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {groupBy === 'none'
              ? flat.length === 0
                ? [
                    <tr key="empty">
                      <td colSpan={7} className="px-3 py-10 text-center text-sm text-muted-foreground">
                        No assets yet.
                      </td>
                    </tr>,
                  ]
                : assetRows(pagedFlat, false, 'all')
              : pagedGroups.map(({ name, items, a }) => {
                  const gopen = openGroups.has(name);
                  const rows: ReactNode[] = [];
                  rows.push(
                    <tr
                      key={`g${name}`}
                      onClick={() => setOpenGroups((s) => toggle(s, name))}
                      className={cn(
                        'cursor-pointer border-b [&>td]:bg-muted/30 hover:[&>td]:bg-muted/50',
                        gopen && '[&>td]:!bg-accent/10',
                      )}
                    >
                      <td className="px-3 py-2.5 align-middle">
                        <div className="flex items-center gap-2">
                          <Chevron open={gopen} />
                          <div>
                            <div className="text-[13px] font-medium text-foreground">{name}</div>
                            <div className="mt-0.5">
                              <Pill>
                                {a.count} holding{a.count === 1 ? '' : 's'}
                              </Pill>
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">
                        {money(a.cost)}
                      </td>
                      <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">
                        {a.fmv > 0 ? money(a.fmv) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">
                        {a.moic.toFixed(2)}×
                      </td>
                      <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">
                        {a.real > 0 ? money(a.real) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">
                        {dpi(a.cost, a.real).toFixed(2)}×
                      </td>
                      <td className="px-3 py-2.5 align-middle text-[13px] text-muted-foreground">—</td>
                    </tr>,
                  );
                  if (gopen) rows.push(...assetRows(items, true, name));
                  return rows;
                })}
          </tbody>
        </table>
      </div>
      <TablePager
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        onPageChange={setPage}
        itemLabel={groupBy === 'none' ? 'asset' : `${GROUP_HEAD[groupBy].toLowerCase()} group`}
      />
    </>
  );
}
