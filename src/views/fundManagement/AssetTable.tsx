'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { Fund, Holding, Investor } from './types';
import {
  buildInvestorGroupLookup,
  entityToFundAdapter,
  formatHolderName,
  getAssetDisplayName,
  getAssetEntity,
  getAssetFundingSources,
  getAssetInvestType,
  mergeHoldingsAcrossFunds,
  resolveInvestorGroupName,
  sliceHoldingsByTxn,
  type AssetHolderInvested,
  type HoldingSlice,
} from './calc';
import { useFundMoney } from './useFundMoney';
import { distinctEnglishName } from '@/lib/fundLedger/format';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Chevron, DeleteRowMenu, DisclosureBadge, DisclosureFootnote, GlossaryTerm, PartialValuationAmount, Pill } from './parts';
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
 * names of every fund/entity holder holding it (the slice's `f` is the primary fund)
 * and, on ungrouped rows only, each holder's invested share. */
type AssetRow = HoldingSlice & {
  fundNames?: string[];
  holderNames?: string[];
  holderBreakdown?: AssetHolderInvested[];
};

/** A holding whose position is closed renders as 'Exited' (see adapters). */
export function isHoldingClosed(h: Pick<Holding, 'st'>): boolean {
  const st = h.st?.toLowerCase();
  return st === 'exited' || st === 'closed';
}

/** "Held by" panel for a whole-asset row held by at least one fund: each
 * holder's Invested and its share of the asset's total Invested. A row with no
 * fund holder never shows it, so investor-held (Startech entity) assets are
 * unchanged. When it does show, every holder line is listed (an entity
 * co-holder included) so the lines reconcile to the total, which is the row's
 * own Invested. */
function AssetHeldBy({
  assetKey,
  breakdown,
  totalInvested,
  money,
  englishByName,
}: {
  assetKey: string;
  breakdown: AssetHolderInvested[] | undefined;
  totalInvested: number;
  money: (v: number) => string;
  englishByName?: Map<string, string>;
}) {
  const fundHolders = new Set(
    (breakdown ?? []).filter((b) => b.kind === 'fund').map((b) => b.holderId),
  );
  if (!breakdown || fundHolders.size === 0) return null;
  const share = (v: number) => (totalInvested > 0 ? (v / totalInvested) * 100 : 0);
  const pct = (v: number) => (totalInvested > 0 ? `${share(v).toFixed(1)}%` : '—');
  const allFunds = fundHolders.size === breakdown.length;
  const headCell = 'border-b px-2.5 pb-1 pt-2.5 text-[11px] uppercase tracking-wide';
  return (
    <div
      className="mt-4 overflow-hidden rounded-lg border bg-card"
      data-testid={`asset-held-by-${assetKey}`}
    >
      <table className="w-full table-fixed border-collapse">
        <colgroup>
          <col />
          <col className="w-[34%]" />
          <col className="w-28" />
        </colgroup>
        <thead>
          <tr>
            <th className={cn(headCell, 'text-left font-semibold text-accent')}>
              Held by
              <span className="ml-1.5 font-medium normal-case tracking-normal text-muted-foreground">
                · {breakdown.length} {allFunds ? 'fund' : 'holder'}
                {breakdown.length === 1 ? '' : 's'}
              </span>
            </th>
            <th className={cn(headCell, 'text-right font-medium text-muted-foreground')}>Share</th>
            <th className={cn(headCell, 'text-right font-medium text-muted-foreground')}>
              Invested
            </th>
          </tr>
        </thead>
        <tbody>
          {breakdown.map((b) => {
            const english = englishByName?.get(b.name);
            return (
              <tr
                key={`${b.kind}:${b.holderId}`}
                className="border-b last:border-b-0"
                data-testid={`asset-held-by-row-${b.holderId}`}
              >
                <td className="px-2.5 py-1.5">
                  <div className="truncate text-xs text-foreground" title={b.name}>
                    {b.name}
                  </div>
                  {english && (
                    <div className="truncate text-[11px] text-muted-foreground" title={english}>
                      {english}
                    </div>
                  )}
                </td>
                <td className="px-2.5 py-1.5">
                  <div className="flex items-center justify-end gap-2">
                    <div className="h-1.5 max-w-[10rem] flex-1 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-accent"
                        style={{ width: `${Math.min(100, share(b.invested))}%` }}
                      />
                    </div>
                    <span className="w-11 text-right text-xs tabular-nums text-muted-foreground">
                      {pct(b.invested)}
                    </span>
                  </div>
                </td>
                <td className="whitespace-nowrap px-2.5 py-1.5 text-right text-xs tabular-nums text-foreground">
                  {money(b.invested)}
                </td>
              </tr>
            );
          })}
          <tr className="border-t bg-muted" data-testid={`asset-held-by-total-${assetKey}`}>
            <td className="px-2.5 py-1.5 text-xs font-semibold text-foreground">Total</td>
            <td className="px-2.5 py-1.5 text-right text-xs tabular-nums text-muted-foreground">
              {pct(totalInvested)}
            </td>
            <td className="whitespace-nowrap px-2.5 py-1.5 text-right text-xs font-semibold tabular-nums text-foreground">
              {money(totalInvested)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** The row's holder label. A co-invested asset shows its primary holder plus a
 * "+N" count; hovering reveals the full holder list in a read-only tooltip. */
function HoldersLabel({
  names,
  englishByName,
}: {
  names: string[];
  /** Recorded name → its English rendering, for the holders that have one. */
  englishByName?: Map<string, string>;
}) {
  const english = (name: string) => englishByName?.get(name);
  if (names.length <= 1) {
    const only = names[0] ?? '';
    return (
      <span className="text-[11px] text-muted-foreground" title={only}>
        {only}
        {english(only) && <span className="text-muted-foreground/70"> ({english(only)})</span>}
      </span>
    );
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
        <div className="text-xs font-semibold text-foreground">Holders</div>
        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          {names.map((n, i) => (
            <li key={i}>
              {n}
              {english(n) && <span className="text-muted-foreground/70"> ({english(n)})</span>}
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The "Asset" tab: every holding across all funds and entities, optionally grouped by fund
 * type / investor / source of fund. Ungrouped, each asset row expands to its
 * full HoldingDetail (Performance / Company & legal / Business / Transactions /
 * Deal economics / Historical value). Grouped, a group row expands to its asset
 * rows, and each asset row expands to the same HoldingDetail.
 */
export function AssetTable({
  funds,
  investors,
  initialGroupBy,
  initialOpenAssets,
}: {
  funds: Fund[];
  investors?: Investor[];
  initialGroupBy?: GroupBy;
  /** Asset rows expanded on first render, as internal row keys
   * (`${scope}::${hkey}` — `all::<assetId>` for an ungrouped row). */
  initialOpenAssets?: string[];
}) {
  const {
    deleteAsset,
    reopenAsset,
    entityNameById,
    sourceNameById,
    analyzeAiOpinion,
    analyzingAiOpinionIds,
  } = useFundData();
  const { money } = useFundMoney();
  const { analyzeWithAI } = useChatContext();
  const { focusCopilot } = useLayoutControl();
  // Fund vehicle view and source-of-funds tracking are per-workspace settings.
  // 'by Fund Type' needs fund vehicles, so it follows the flag. 'by Investor'
  // does not: investor groups (`parent_investor_id`) exist independently of
  // fund vehicles, so grouping by investor stays available in both states — it
  // is merely the default when the flag is off (the intended Startech setting).
  // Source of funds remains independently controlled.
  const fundVehicleViewEnabled = useFeatureEnabled('FUND_VEHICLE_VIEW_ENABLED');
  const sourceOfFundsEnabled = useFeatureEnabled('SOURCE_OF_FUNDS_ENABLED');
  const defaultGroupBy: GroupBy = initialGroupBy ?? (fundVehicleViewEnabled ? 'none' : 'investor');
  const [groupBy, setGroupBy] = useState<GroupBy>(defaultGroupBy);
  const groupOptions = useMemo(
    () =>
      GROUP_OPTIONS.filter((o) => {
        if (o.k === 'fund' && !fundVehicleViewEnabled) return false;
        if (o.k === 'source' && !sourceOfFundsEnabled) return false;
        return true;
      }),
    [fundVehicleViewEnabled, sourceOfFundsEnabled],
  );

  const effectiveGroupBy: GroupBy =
    (!fundVehicleViewEnabled && groupBy === 'fund') ||
    (!sourceOfFundsEnabled && groupBy === 'source')
      ? defaultGroupBy
      : groupBy;

  useEffect(() => {
    if (groupBy !== effectiveGroupBy) {
      setGroupBy(effectiveGroupBy);
    }
  }, [groupBy, effectiveGroupBy]);


  // "Dive deeper" hands the existing AI Opinion verdict to the copilot and
  // reveals the pane so the discussion is immediately visible.
  const handleDiveDeeper = (h: Holding) => {
    const name = getAssetDisplayName(h) || 'this holding';
    const verdict = h.aiOpinionVerdict ?? 'unknown';
    const summary = h.aiOpinionSummary ?? 'no summary available';
    const idHint = h.id ? ` (asset_id: ${h.id})` : '';
    analyzeWithAI(
      `Dive deeper into the AI Opinion for ${name}${idHint}. The current verdict is "${verdict}" with the rationale: "${summary}". ` +
        `Start with get_fund_asset_details${h.id ? ` using asset_id "${h.id}"` : ' for this holding by name'} to pull the recorded metrics and valuation history, then explain the reasoning in more detail, surface the key risks and opportunities, and tell me what additional diligence would strengthen this assessment.`,
    );
    focusCopilot();
  };
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const [openAssets, setOpenAssets] = useState<Set<string>>(
    () => new Set(initialOpenAssets ?? []),
  );
  const [page, setPage] = useState(1);

  // Grouping mode changes what a "row" is (assets vs. groups), so restart
  // paging from the first page to avoid landing on an out-of-range page.
  useEffect(() => setPage(1), [effectiveGroupBy]);

  const toggle = <T,>(set: Set<T>, val: T) => {
    const next = new Set(set);
    next.has(val) ? next.delete(val) : next.add(val);
    return next;
  };

  // Filter out fund-target holdings (FoF) when Fund Vehicle View is enabled,
  // since they are displayed in the Fund tab instead of the Asset tab.
  // Never mutate Fund.h or Investor.holdings directly.
  const visibleFunds = useMemo(() => {
    if (!fundVehicleViewEnabled) return funds;
    return funds.map((f) => ({
      ...f,
      h: f.h.filter((h) => h.targetKind !== 'fund'),
    }));
  }, [funds, fundVehicleViewEnabled]);

  const visibleInvestors = useMemo(() => {
    if (!fundVehicleViewEnabled || !investors) return investors;
    return investors.map((e) => ({
      ...e,
      holdings: e.holdings ? e.holdings.filter((h) => h.targetKind !== 'fund') : e.holdings,
    }));
  }, [investors, fundVehicleViewEnabled]);

  // Every row (grouped or not) is a HoldingSlice: for "No grouping" and "by
  // Fund Type" the slice carries the whole-asset numbers; for "by Investor" and
  // "by Source of Fund" it carries only that group's transaction-level slice.
  const wholeSlice = (
    h: Holding,
    f: Fund,
    hi: number,
    holderNames?: string[],
  ): AssetRow => ({
    h,
    f,
    hkey: `${f.id}_${hi}`,
    cost: h.cost,
    fmv: h.fmv,
    real: h.real,
    moic: h.moic,
    holderNames: holderNames ?? [f.n],
  });

  // Ungrouped rows are whole assets: a co-invested asset's per-fund/entity scoped
  // copies are merged back into one row carrying the asset totals and every
  // holding fund/entity's name (largest share first).
  const flat: AssetRow[] = mergeHoldingsAcrossFunds(visibleFunds, visibleInvestors).map(
    ({ key, h, funds: held, holders, holderNames, holderBreakdown }) => {
      const primaryHolder = holders?.[0];
      const primaryFund =
        held[0] ??
        (primaryHolder?.investor
          ? entityToFundAdapter(primaryHolder.investor)
          : undefined);

      return {
        h,
        f: primaryFund!,
        hkey: key,
        cost: h.cost,
        fmv: h.fmv,
        real: h.real,
        moic: h.moic,
        fundNames: held.length > 1 ? held.map((x) => x.n) : undefined,
        holderNames,
        holderBreakdown,
      };
    },
  );

  const aggSlices = (items: HoldingSlice[]) => {
    let cost = 0;
    let fmv = 0;
    let real = 0;
    let anyUnvalued = false;
    items.forEach((it) => {
      if (it.h.displayOnly || it.f?.displayOnly) return;
      cost += it.cost;
      if (it.fmv != null) {
        fmv += it.fmv;
      } else {
        anyUnvalued = true;
      }
      real += it.real;
    });
    return {
      cost,
      fmv,
      real,
      moic: anyUnvalued || cost <= 0 ? null : (fmv + real) / cost,
      count: items.length,
      valuationCoverage: anyUnvalued ? 'partial' : 'complete',
    };
  };

  const buildGroups = (): Map<string, AssetRow[]> => {
    if (effectiveGroupBy === 'fund') {
      const map = new Map<string, AssetRow[]>();
      const push = (groupName: string, row: AssetRow) => {
        if (!map.has(groupName)) map.set(groupName, []);
        map.get(groupName)!.push(row);
      };

      visibleFunds.forEach((f) =>
        f.h.forEach((h, hi) => {
          push(f.n, wholeSlice(h, f, hi, [f.n]));
        }),
      );

      (visibleInvestors ?? []).forEach((e) => {
        const f = entityToFundAdapter(e);
        const holderLabel = formatHolderName(e);
        (e.holdings ?? []).forEach((h, hi) => {
          push(e.n, wholeSlice(h, f, hi, [holderLabel]));
        });
      });
      return map;
    }
    if (effectiveGroupBy === 'investor') {
      const entityIdSet = new Set((visibleInvestors ?? []).map((inv) => inv.id));
      return sliceHoldingsByTxn(
        visibleFunds,
        (t, h, f) => {
          if (entityIdSet.has(f.id)) {
            return t.holdingEntityId
              ? entityNameById.get(t.holdingEntityId) ?? f.n
              : f.n;
          }
          return t.holdingEntityId
            ? entityNameById.get(t.holdingEntityId) ?? getAssetEntity(h) ?? 'Unspecified'
            : getAssetEntity(h) || 'Unspecified';
        },
        (h, f) => {
          if (entityIdSet.has(f.id)) {
            return [f.n];
          }
          return [getAssetEntity(h) || 'Unspecified'];
        },
        visibleInvestors,
      );
    }
    return sliceHoldingsByTxn(
      visibleFunds,
      (t, h) =>
        t.fundingSourceId
          ? sourceNameById.get(t.fundingSourceId) ?? getAssetFundingSources(h)[0]
          : getAssetFundingSources(h)[0],
      (h) => getAssetFundingSources(h),
      visibleInvestors,
    );
  };

  const investorGroupLookup = useMemo(
    () => buildInvestorGroupLookup(investors),
    [investors],
  );

  // Group keys are the bare fund/entity name because they double as lookup keys
  // (`resolveInvestorGroupName` matches on them), so the English name is carried
  // in a side lookup and only ever rendered.
  const englishNameByName = useMemo(() => {
    const map = new Map<string, string>();
    for (const fund of funds ?? []) {
      const english = distinctEnglishName(fund.n, fund.englishName);
      if (english) map.set(fund.n, english);
    }
    for (const entity of investors ?? []) {
      const english = distinctEnglishName(entity.n, entity.englishName);
      if (!english) continue;
      map.set(entity.n, english);
      // Holder labels carry the parent group — `高亚 (Parent Group)` — so the
      // formatted form is registered too or a grouped entity's holder line
      // would never resolve.
      map.set(formatHolderName(entity), english);
    }
    return map;
  }, [funds, investors]);

  /** The rail is rotated vertical text in an 8px cell, so an English line has
   *  nowhere to go — it rides in the hover title instead. */
  const englishRail = (name: string) => {
    const english = englishNameByName.get(name);
    return english ? `${name} (${english})` : name;
  };
  const groups =
    effectiveGroupBy === 'none'
      ? []
      : [...buildGroups().entries()].map(([name, items]) => ({
          name,
          items,
          a: aggSlices(items),
          investorGroupName:
            effectiveGroupBy === 'investor'
              ? resolveInvestorGroupName(investorGroupLookup, name)
              : null,
        }));
  const investorGroupFmv = new Map<string, number>();
  groups.forEach((group) => {
    if (!group.investorGroupName) return;
    investorGroupFmv.set(
      group.investorGroupName,
      (investorGroupFmv.get(group.investorGroupName) ?? 0) + group.a.fmv,
    );
  });
  groups.sort((x, y) => {
    if (effectiveGroupBy !== 'investor') return y.a.fmv - x.a.fmv;
    if (x.investorGroupName && !y.investorGroupName) return -1;
    if (!x.investorGroupName && y.investorGroupName) return 1;
    if (
      x.investorGroupName &&
      y.investorGroupName &&
      x.investorGroupName !== y.investorGroupName
    ) {
      const groupDelta =
        (investorGroupFmv.get(y.investorGroupName) ?? 0) -
        (investorGroupFmv.get(x.investorGroupName) ?? 0);
      if (groupDelta !== 0) return groupDelta;
      return (x.investorGroupName ?? '').localeCompare(y.investorGroupName ?? '');
    }
    return y.a.fmv - x.a.fmv;
  });

  // Paginate whichever list is being shown — flat asset rows when ungrouped,
  // group rows when grouped. Slicing the top-level rows (not the expanded
  // detail panels) keeps a heavy portfolio from rendering hundreds of rows at
  // once, complementing the batched load that removed the per-asset fetches.
  const total = effectiveGroupBy === 'none' ? flat.length : groups.length;
  const start = (Math.min(page, Math.max(1, Math.ceil(total / PAGE_SIZE))) - 1) * PAGE_SIZE;
  const pagedFlat = [...flat].sort((x, y) => (y.fmv ?? 0) - (x.fmv ?? 0)).slice(start, start + PAGE_SIZE);
  const pagedGroups = groups.slice(start, start + PAGE_SIZE);
  const hasInvestorGroups =
    effectiveGroupBy === 'investor' && groups.some((group) => group.investorGroupName);

  const hasDisplayOnlyOnScreen =
    effectiveGroupBy === 'none'
      ? pagedFlat.some((r) => r.h.displayOnly || r.f?.displayOnly)
      : pagedGroups.some((g) => g.items.some((it) => it.h.displayOnly || it.f?.displayOnly));

  // A single asset row + (if open) its detail panel. `rowKey` scopes the
  // open-state so the same holding under two source groups toggles independently.
  const assetRows = (items: AssetRow[], nested: boolean, scope: string): ReactNode[] => {
    const out: ReactNode[] = [];
    [...items]
      .sort((x, y) => (y.fmv ?? 0) - (x.fmv ?? 0))
      .forEach(({ h, f, hkey, cost, fmv, real, moic, fundNames, holderNames, holderBreakdown }) => {
        const isDisplayOnly = Boolean(h.displayOnly || f?.displayOnly);
        const disclosure = h.disclosure ?? f?.disclosure;
        const rowKey = `${scope}::${hkey}`;
        const hopen = openAssets.has(rowKey);
        out.push(
          <tr
            key={`a${rowKey}`}
            onClick={isDisplayOnly ? undefined : () => setOpenAssets((s) => toggle(s, rowKey))}
            className={cn(
              isDisplayOnly
                ? 'border-b [&>td]:bg-muted/10'
                : 'cursor-pointer border-b [&>td]:bg-muted/10 hover:[&>td]:bg-background',
              hopen && !isDisplayOnly && '[&>td]:!bg-accent/10',
            )}
          >
            <td className="py-2 pl-3 pr-3 align-middle">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center">
                  {nested && <span className="w-5 shrink-0" />}
                  <span className="mr-2 w-3 shrink-0 text-[11px] text-muted-foreground">
                    {!isDisplayOnly ? (hopen ? '▾' : '▸') : ''}
                  </span>
                  <div className={cn(nested && 'border-l-2 border-border pl-2.5')}>
                    <div className="flex items-center gap-1.5">
                      <div className="text-[13px] font-medium text-foreground">
                        {getAssetDisplayName(h)}
                      </div>
                      {isDisplayOnly && disclosure && (
                        <DisclosureBadge reason={disclosure} />
                      )}
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                      <Pill>
                        <GlossaryTerm term={TYPE_TERM[h.tp] || 'equity'}>
                          {HOLDING_TYPE_NAME[h.tp] || h.tp}
                        </GlossaryTerm>
                      </Pill>
                      <Pill>{getAssetInvestType(h)}</Pill>
                      <HoldersLabel
                        names={holderNames ?? fundNames ?? (f ? [f.n] : [])}
                        englishByName={englishNameByName}
                      />
                      {h.dt && <span className="text-[11px] text-muted-foreground">· {h.dt}</span>}
                    </div>
                  </div>
                </div>
                {!isDisplayOnly && h.id && (isHoldingClosed(h) ? (
                  <DeleteRowMenu
                    tone="restore"
                    label="Reopen holding"
                    title={`Reopen "${getAssetDisplayName(h)}"?`}
                    description="This reopens the holding's position so it can receive new transactions and valuations again. A holding linked to more than one position cannot be reopened."
                    confirmLabel="Reopen holding"
                    onConfirm={async () => {
                      await reopenAsset(f, h);
                    }}
                  />
                ) : (
                  <DeleteRowMenu
                    label="Close holding"
                    title={`Close "${getAssetDisplayName(h)}"?`}
                    description="This closes the holding's positions while retaining full transaction and valuation history. Active positions must have zero remaining quantity (and no unfunded commitment) to close."
                    confirmLabel="Close holding"
                    onConfirm={async () => {
                      await deleteAsset(f, h);
                    }}
                  />
                ))}
              </div>
            </td>
            <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
              {isDisplayOnly ? '—' : money(cost)}
            </td>
            <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
              {isDisplayOnly ? '—' : fmv != null ? money(fmv) : '—'}
            </td>
            <td className="px-3 py-2 text-right align-middle text-[13px] font-medium text-foreground">
              {isDisplayOnly ? '—' : moic != null ? `${moic.toFixed(2)}×` : '—'}
            </td>
            <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
              {isDisplayOnly ? '—' : real > 0 ? money(real) : '—'}
            </td>
            <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
              {isDisplayOnly ? '—' : `${dpi(cost, real).toFixed(2)}×`}
            </td>
            <td className="px-3 py-2 align-middle">
              <Pill>{h.st}</Pill>
            </td>
            <td className="min-w-[260px] max-w-[390px] px-3 py-2 align-middle" onClick={(e) => e.stopPropagation()}>
              <FundAiOpinionCell
                holding={h}
                analyzing={h.id ? analyzingAiOpinionIds.has(h.id) : false}
                onAnalyze={analyzeAiOpinion}
                onDiveDeeper={handleDiveDeeper}
              />
            </td>
          </tr>,
        );
        if (hopen && !isDisplayOnly) {
          out.push(
            <tr key={`d${rowKey}`} className="border-b">
              <td colSpan={8} className="bg-background px-3 pb-3.5 pt-2">
                <HoldingDetail
                  fund={f}
                  holding={h}
                  footer={
                    <AssetHeldBy
                      assetKey={hkey}
                      breakdown={holderBreakdown}
                      totalInvested={cost}
                      money={money}
                      englishByName={englishNameByName}
                    />
                  }
                />
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
              effectiveGroupBy === k
                ? 'border-accent bg-accent text-accent-foreground'
                : 'bg-muted/60 text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[1040px] border-collapse">
          <thead>
            <tr>
              {hasInvestorGroups && (
                <th className="w-8 border-b border-r bg-muted/50 p-0" />
              )}
              <th className="whitespace-nowrap border-b bg-muted/50 px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {effectiveGroupBy === 'none' ? 'Asset' : GROUP_HEAD[effectiveGroupBy]}
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
              <th className="min-w-[260px] max-w-[390px] whitespace-nowrap border-b bg-muted/50 px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
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
            {effectiveGroupBy === 'none'
              ? flat.length === 0
                ? [
                    <tr key="empty">
                      <td
                        colSpan={hasInvestorGroups ? 9 : 8}
                        className="px-3 py-10 text-center text-sm text-muted-foreground"
                      >
                        No assets yet.
                      </td>
                    </tr>,
                  ]
                : assetRows(pagedFlat, false, 'all')
              : pagedGroups.length === 0
                ? [
                    <tr key="empty">
                      <td
                        colSpan={hasInvestorGroups ? 9 : 8}
                        className="px-3 py-10 text-center text-sm text-muted-foreground"
                      >
                        No assets yet.
                      </td>
                    </tr>,
                  ]
                : pagedGroups.map(({ name, items, a, investorGroupName }, groupIndex) => {
                  const gopen = openGroups.has(name);
                  const isAllDisplayOnly = items.length > 0 && items.every((it) => it.h.displayOnly || it.f?.displayOnly);
                  const subRows = gopen ? assetRows(items, true, name) : [];
                  const previousInvestorGroupName = pagedGroups[groupIndex - 1]?.investorGroupName;
                  const isFirstInInvestorGroup =
                    Boolean(investorGroupName) &&
                    investorGroupName !== previousInvestorGroupName;
                  let investorGroupRowSpan = 0;
                  if (isFirstInInvestorGroup) {
                    for (let i = groupIndex; i < pagedGroups.length; i += 1) {
                      const groupedEntity = pagedGroups[i];
                      if (groupedEntity.investorGroupName !== investorGroupName) break;
                      investorGroupRowSpan +=
                        1 +
                        (openGroups.has(groupedEntity.name)
                          ? assetRows(groupedEntity.items, true, groupedEntity.name).length
                          : 0);
                    }
                  }
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
                      {hasInvestorGroups && isFirstInInvestorGroup && (
                        <td
                          rowSpan={investorGroupRowSpan}
                          className="relative w-8 border-b border-r bg-muted/30 p-2 text-center align-middle select-none"
                        >
                          <div
                            className="absolute inset-0 flex items-center justify-center overflow-hidden p-2"
                            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
                          >
                            <span
                              title={englishRail(investorGroupName)}
                              className="truncate whitespace-nowrap text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                              {investorGroupName}
                            </span>
                          </div>
                        </td>
                      )}
                      {hasInvestorGroups && !investorGroupName && (
                        <td
                          rowSpan={1 + subRows.length}
                          className="w-8 border-b border-r bg-card"
                        />
                      )}
                      <td className="px-3 py-2.5 align-middle">
                        <div className="flex items-center gap-2">
                          <Chevron open={gopen} />
                          <div>
                            <div className="text-[13px] font-medium text-foreground">{name}</div>
                            {englishNameByName.get(name) && (
                              <div
                                className="text-[11px] leading-tight text-muted-foreground"
                                title={englishNameByName.get(name)}
                              >
                                {englishNameByName.get(name)}
                              </div>
                            )}
                            <div className="mt-0.5">
                              <Pill>
                                {a.count} holding{a.count === 1 ? '' : 's'}
                              </Pill>
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">
                        {isAllDisplayOnly ? '—' : money(a.cost)}
                      </td>
                      <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">
                        {isAllDisplayOnly ? (
                          '—'
                        ) : (
                          <PartialValuationAmount partial={a.valuationCoverage === 'partial'}>
                            {a.valuationCoverage === 'partial' || a.fmv > 0 ? money(a.fmv) : '—'}
                          </PartialValuationAmount>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">
                        {isAllDisplayOnly ? '—' : a.moic != null ? `${a.moic.toFixed(2)}×` : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">
                        {isAllDisplayOnly ? '—' : a.real > 0 ? money(a.real) : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">
                        {isAllDisplayOnly ? '—' : `${dpi(a.cost, a.real).toFixed(2)}×`}
                      </td>
                      <td className="px-3 py-2.5 align-middle text-[13px] text-muted-foreground">—</td>
                      <td className="px-3 py-2.5 align-middle text-[13px] text-muted-foreground">—</td>
                    </tr>,
                  );
                  rows.push(...subRows);
                  return rows;
                })}
          </tbody>
        </table>
      </div>
      {hasDisplayOnlyOnScreen && <DisclosureFootnote />}
      <TablePager
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        onPageChange={setPage}
        itemLabel={effectiveGroupBy === 'none' ? 'asset' : `${GROUP_HEAD[effectiveGroupBy].toLowerCase()} group`}
      />
    </>
  );
}
