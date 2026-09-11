'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Fund, Holding, HoldingType, Investor } from './types';
import { formatHolderCounts, formatHolderName, getPositionKeys } from './calc';
import { useFundMoney } from './useFundMoney';
import { GlossaryTerm } from './parts';
import { distinctEnglishName } from '@/lib/fundLedger/format';

interface Segment {
  label: string;
  /** English rendering of `label`, when the entity is recorded under a
   *  non-English name. Shown beside it, never folded into the label itself —
   *  `formatHolderName`'s output doubles as a grouping key elsewhere. */
  english?: string;
  pct: number;
  color: string;
  rows: [string, string][];
}

const FUND_COLORS = ['bg-accent/40', 'bg-primary/40', 'bg-success/40', 'bg-warning/40'];
const TYPE_COLORS: Record<HoldingType, string> = {
  'Direct Investments': 'bg-accent/40',
  Equity: 'bg-accent/40',
  Cash: 'bg-success/40',
  Obligation: 'bg-warning/40',
  Shares: 'bg-primary/40',
  'Fund of funds': 'bg-muted-foreground/30',
};
const TYPE_LABEL: Record<HoldingType, string> = {
  'Direct Investments': 'Companies',
  Equity: 'Companies',
  Cash: 'Cash',
  Obligation: 'Loans',
  Shares: 'Public shares',
  'Fund of funds': 'Funds',
};

/** Section (b): the stacked "Money breakdown" bar, by fund or by holding type. */
export function MoneyBreakdown({
  funds,
  investors,
}: {
  funds: Fund[];
  investors?: Investor[];
}) {
  const { money } = useFundMoney();
  const [tab, setTab] = useState<'fund' | 'type'>('fund');

  const holdingEntities = (investors ?? []).filter(
    (inv) => (inv.holdings?.filter((h) => !h.displayOnly).length ?? 0) > 0,
  );

  const validFunds = funds.filter((f) => !f.displayOnly);

  const entityItems = holdingEntities.map((e, i) => {
    const validHoldings = (e.holdings ?? []).filter((h) => !h.displayOnly);
    const directCost = validHoldings.reduce((s, h) => s + h.cost, 0);
    const directCommit = validHoldings.reduce(
      (s, h) => s + (h.d?.commit ?? h.cost),
      0,
    );
    const directFmv = validHoldings.reduce((s, h) => s + (h.fmv ?? 0), 0);
    const directReal = validHoldings.reduce((s, h) => s + h.real, 0);
    const eCommit = directCommit > 0 ? directCommit : directCost;
    const eInvested = directCost;
    const eMoic =
      e.valuationCoverage === 'partial' || directCost <= 0
        ? null
        : (directFmv + directReal) / directCost;

    return {
      label: formatHolderName(e),
      english: distinctEnglishName(e.n, e.englishName),
      commit: eCommit,
      invested: eInvested,
      moic: eMoic,
      color: FUND_COLORS[(validFunds.length + i) % FUND_COLORS.length],
    };
  });

  const totalFundCommit = validFunds.reduce((s, f) => s + f.size, 0);
  const totalEntityCommit = entityItems.reduce((s, e) => s + e.commit, 0);
  const totalC = totalFundCommit + totalEntityCommit || 1;

  const fundSegs: Segment[] = [
    ...validFunds.map((f, i) => ({
      label: f.n,
      english: distinctEnglishName(f.n, f.englishName),
      pct: (f.size / totalC) * 100,
      color: FUND_COLORS[i % FUND_COLORS.length],
      rows: [
        ['Commitment', `${money(f.size)} · ${Math.round((f.size / totalC) * 100)}%`],
        ['Invested', `${money(f.called)} (${f.calledPct.toFixed(0)}% invested)`],
        [
          'MOIC / IRR',
          `${f.tvpi != null ? `${f.tvpi.toFixed(2)}×` : '—'} · ${f.irr > 0 ? '+' : ''}${f.irr.toFixed(1)}%`,
        ],
        ['Phase', f.st],
      ] as [string, string][],
    })),
    ...entityItems.map((e) => ({
      label: e.label,
      english: e.english,
      pct: (e.commit / totalC) * 100,
      color: e.color,
      rows: [
        ['Commitment', `${money(e.commit)} · ${Math.round((e.commit / totalC) * 100)}%`],
        [
          'Invested',
          `${money(e.invested)} (${e.commit ? Math.round((e.invested / e.commit) * 100) : 100}% invested)`,
        ],
        ['MOIC / IRR', e.moic != null ? `${e.moic.toFixed(2)}×` : '—'],
        ['Phase', 'Active'],
      ] as [string, string][],
    })),
  ];

  const tv: Partial<Record<HoldingType, number>> = {};
  const seenPositions = new Set<string>();
  const seenHoldingObjects = new Set<Holding>();
  const allHoldings: Holding[] = [];

  const addHoldingToType = (h: Holding) => {
    if (h.displayOnly) return;
    const posKeys = getPositionKeys(h);
    if (posKeys.length > 0) {
      if (posKeys.some((pk) => seenPositions.has(pk))) return;
      posKeys.forEach((pk) => seenPositions.add(pk));
    } else {
      if (seenHoldingObjects.has(h)) return;
      seenHoldingObjects.add(h);
    }
    allHoldings.push(h);
    tv[h.tp] = (tv[h.tp] || 0) + (h.fmv ?? 0);
  };

  validFunds.forEach((f) =>
    f.h.filter((h) => !h.displayOnly).forEach(addHoldingToType),
  );
  (investors ?? []).forEach((e) =>
    (e.holdings ?? []).filter((h) => !h.displayOnly).forEach(addHoldingToType),
  );

  const totalFMV = Object.values(tv).reduce((s, v) => s + (v || 0), 0) || 1;
  const holderCountDesc =
    holdingEntities.length === 0
      ? `${validFunds.length} fund${validFunds.length === 1 ? '' : 's'}`
      : formatHolderCounts(validFunds.length, holdingEntities.length);

  const typeSegs: Segment[] = (Object.entries(tv) as [HoldingType, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([tp, fmv]) => {
      const cnt = allHoldings.filter((h) => h.tp === tp).length;
      return {
        label: TYPE_LABEL[tp] || tp,
        pct: (fmv / totalFMV) * 100,
        color: TYPE_COLORS[tp] || TYPE_COLORS.Equity,
        rows: [
          ['Unrealized Market Value', `${money(fmv)} · ${Math.round((fmv / totalFMV) * 100)}%`],
          ['Holdings', `${cnt} across ${holderCountDesc}`],
        ],
      };
    });

  const segs = tab === 'fund' ? fundSegs : typeSegs;
  const fundTabLabel =
    holdingEntities.length === 0
      ? 'By fund'
      : validFunds.length === 0
        ? 'By entity'
        : 'By fund / entity';

  return (
    <div className="mb-4 rounded-lg border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <span className="text-xs font-medium text-foreground">Money breakdown</span>
        <div className="ml-auto inline-flex overflow-hidden rounded-full border bg-background">
          {(
            [
              ['fund', fundTabLabel],
              ['type', 'By holding type'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setTab(k)}
              className={cn(
                'px-3.5 py-1 text-xs',
                tab === k
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-2 text-[11px] text-muted-foreground">
        {tab === 'fund' ? (
          <>
            Share of total <GlossaryTerm term="pledged">commitment</GlossaryTerm>
          </>
        ) : (
          <>
            Share of <GlossaryTerm term="currentvalue">unrealized market value</GlossaryTerm>
          </>
        )}
      </div>

      <div className="flex h-7 overflow-hidden rounded-lg border">
        {segs.map((s, i) => (
          <Tooltip key={i}>
            <TooltipTrigger asChild>
              <div
                className={cn(s.color, 'cursor-default hover:brightness-95', i < segs.length - 1 && 'border-r border-background')}
                style={{ flexBasis: `${s.pct.toFixed(2)}%`, flexGrow: 0, flexShrink: 0 }}
              />
            </TooltipTrigger>
            <TooltipContent>
              <div className="mb-1.5 text-xs font-medium text-foreground">
                {s.label}
                {s.english && (
                  <span className="ml-1 font-normal text-muted-foreground">({s.english})</span>
                )}
              </div>
              <div className="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
                {s.rows.map(([l, v], j) => (
                  <div key={j} className="contents">
                    <span className="text-[11px] text-muted-foreground">{l}</span>
                    <span className="text-[11px] text-foreground">{v}</span>
                  </div>
                ))}
              </div>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1.5">
        {segs.map((s, i) => (
          <span key={i} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className={cn('h-2.5 w-2.5 shrink-0 rounded-sm border', s.color)} />
            <span title={s.english ? `${s.label} (${s.english})` : s.label}>
              {s.label}
              {s.english && <span className="text-muted-foreground/70"> ({s.english})</span>}
            </span>
            <span className="text-muted-foreground/70"> · {Math.round(s.pct)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}
