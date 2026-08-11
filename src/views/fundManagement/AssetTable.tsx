'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { Fund, Holding } from './types';
import {
  getAssetDisplayName,
  getAssetEntity,
  getAssetFundingSources,
  getAssetInvestType,
  mergeHoldingsAcrossFunds,
  sliceHoldingsByTxn,
  type HoldingSlice,
} from './calc';
import { useFundMoney } from './useFundMoney';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Chevron, DeleteRowMenu, GlossaryTerm, Pill } from './parts';
import { HoldingDetail } from './HoldingDetail';
import { TablePager } from './TablePager';
import { useFundData } from './context';
import { useFeatureEnabled } from '@/components/layout/FeatureFlagsContext';
import { useChatContext } from '@/components/chat/ChatProvider';
import { useLayoutControl } from '@/components/layout/LayoutControlContext';
import { FundAiOpinionCell } from './FundAiOpinionCell';

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

/** A table row: a holding slice, plus — for a merged co-invested asset — the
 * names of every fund holding it (the slice's `f` is the primary fund). */
type AssetRow = HoldingSlice & { fundNames?: string[] };

/** The row's fund label. A co-invested asset shows its primary fund plus a
 * "+N" count; hovering reveals the full fund list in a read-only tooltip. */
function FundsLabel({ names }: { names: string[] }) {
  if (names.length <= 1) {
    return <span className="text-[11px] text-muted-foreground">{names[0]}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-default whitespace-nowrap text-[11px] text-muted-foreground">
          {names[0]}{' '}
          <span className="ml-0.5 inline-block rounded border bg-muted px-1 font-medium">
            +{names.length - 1}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-[280px]">
        <div className="text-xs font-semibold text-foreground">Funds</div>
        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          {names.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

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
  const {
    deleteAsset,
    refreshAll,
    entityNameById,
    sourceNameById,
    analyzeAiOpinion,
    analyzingAiOpinionIds,
  } = useFundData();
  const { money } = useFundMoney();
  const { analyzeWithAI } = useChatContext();
  const { focusCopilot } = useLayoutControl();
  const [groupBy, setGroupBy] = useState<GroupBy>('none');
  // Source-of-funds tracking is a per-workspace setting; when off, drop the
  // "by Source of Fund" grouping and coerce an already-selected 'source' mode
  // back to ungrouped.
  const sourceOfFundsEnabled = useFeatureEnabled('SOURCE_OF_FUNDS_ENABLED');
  const groupOptions = sourceOfFundsEnabled
    ? GROUP_OPTIONS
    : GROUP_OPTIONS.filter((o) => o.k !== 'source');
  useEffect(() => {
    if (!sourceOfFundsEnabled && groupBy === 'source') setGroupBy('none');
  }, [sourceOfFundsEnabled, groupBy]);

  // "Dive deeper" hands the existing AI Opinion verdict to the copilot and
  // reveals the pane so the discussion is immediately visible.
  const handleDiveDeeper = (h: Holding) => {
    const name = getAssetDisplayName(h) || 'this holding';
    const verdict = h.aiOpinionVerdict ?? 'unknown';
    const summary = h.aiOpinionSummary ?? 'no summary available';
    const idHint = h.id ? ` (fund_asset_id: ${h.id})` : '';
    analyzeWithAI(
      `Dive deeper into the AI Opinion for ${name}${idHint}. The current verdict is "${verdict}" with the rationale: "${summary}". ` +
        `Start with get_fund_asset_details${h.id ? ` using fund_asset_id "${h.id}"` : ' for this holding by name'} to pull the recorded metrics and valuation history, then explain the reasoning in more detail, surface the key risks and opportunities, and tell me what additional diligence would strengthen this assessment.`,
    );
    focusCopilot();
  };
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

  // Ungrouped rows are whole assets: a co-invested asset's per-fund scoped
  // copies are merged back into one row carrying the asset totals and every
  // holding fund's name (largest share first).
  const flat: AssetRow[] = mergeHoldingsAcrossFunds(funds).map(({ key, h, funds: held }) => ({
    h,
    f: held[0],
    hkey: key,
    cost: h.cost,
    fmv: h.fmv,
    real: h.real,
    moic: h.moic,
    fundNames: held.length > 1 ? held.map((x) => x.n) : undefined,
  }));

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
  const assetRows = (items: AssetRow[], nested: boolean, scope: string): ReactNode[] => {
    const out: ReactNode[] = [];
    [...items]
      .sort((x, y) => y.fmv - x.fmv)
      .forEach(({ h, f, hkey, cost, fmv, real, moic, fundNames }) => {
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
                    <div className="text-[13px] font-medium text-foreground">
                      {getAssetDisplayName(h)}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <Pill>
                        <GlossaryTerm term={TYPE_TERM[h.tp] || 'equity'}>
                          {HOLDING_TYPE_NAME[h.tp] || h.tp}
                        </GlossaryTerm>
                      </Pill>
                      <Pill>{getAssetInvestType(h)}</Pill>
                      <FundsLabel names={fundNames ?? [f.n]} />
                      {h.dt && <span className="text-[11px] text-muted-foreground">· {h.dt}</span>}
                    </div>
                  </div>
                </div>
                {h.id && (
                  <DeleteRowMenu
                    label="Delete holding"
                    title={`Delete "${getAssetDisplayName(h)}"?`}
                    description="This will permanently delete this holding and its full transaction and valuation history. This action cannot be undone."
                    onConfirm={async () => {
                      await deleteAsset(f, h);
                      // A merged co-invested row exists under several funds;
                      // deleteAsset only reloads the primary fund, so refresh
                      // the rest or their stale copies keep the row visible.
                      if (fundNames) await refreshAll();
                    }}
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
            <td className="min-w-[300px] max-w-[390px] px-3 py-2 align-middle" onClick={(e) => e.stopPropagation()}>
              <FundAiOpinionCell
                holding={h}
                analyzing={h.id ? analyzingAiOpinionIds.has(h.id) : false}
                onAnalyze={analyzeAiOpinion}
                onDiveDeeper={handleDiveDeeper}
              />
            </td>
          </tr>,
        );
        if (hopen) {
          out.push(
            <tr key={`d${rowKey}`} className="border-b">
              <td colSpan={8} className="bg-background px-3 pb-3.5 pt-2">
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
        {groupOptions.map(({ k, label }) => (
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
        <table className="w-full min-w-[1120px] border-collapse">
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
              <th className="min-w-[300px] max-w-[390px] whitespace-nowrap border-b bg-muted/50 px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-help border-b border-dotted border-muted-foreground/50">
                      AI Opinion
                    </span>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-[280px]">
                    <p className="text-xs">
                      AI-generated analysis, not investment advice. Confidence
                      reflects how complete the holding&apos;s recorded data is.
                    </p>
                  </TooltipContent>
                </Tooltip>
              </th>
            </tr>
          </thead>
          <tbody>
            {groupBy === 'none'
              ? flat.length === 0
                ? [
                    <tr key="empty">
                      <td colSpan={8} className="px-3 py-10 text-center text-sm text-muted-foreground">
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
