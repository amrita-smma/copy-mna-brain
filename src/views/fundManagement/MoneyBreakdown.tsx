'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { Fund, HoldingType } from './types';
import { money } from './calc';
import { GlossaryTerm } from './parts';

interface Segment {
  label: string;
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
export function MoneyBreakdown({ funds }: { funds: Fund[] }) {
  const [tab, setTab] = useState<'fund' | 'type'>('fund');

  const totalC = funds.reduce((s, f) => s + f.size, 0) || 1;
  const fundSegs: Segment[] = funds.map((f, i) => ({
    label: f.n,
    pct: (f.size / totalC) * 100,
    color: FUND_COLORS[i % FUND_COLORS.length],
    rows: [
      ['Commitment', `${money(f.size)} · ${Math.round((f.size / totalC) * 100)}%`],
      ['Invested', `${money(f.called)} (${f.calledPct.toFixed(0)}% invested)`],
      ['MOIC / IRR', `${f.tvpi.toFixed(2)}× · ${f.irr > 0 ? '+' : ''}${f.irr.toFixed(1)}%`],
      ['Phase', f.st],
    ],
  }));

  const tv: Partial<Record<HoldingType, number>> = {};
  funds.forEach((f) => f.h.forEach((h) => (tv[h.tp] = (tv[h.tp] || 0) + h.fmv)));
  const totalFMV = Object.values(tv).reduce((s, v) => s + (v || 0), 0) || 1;
  const typeSegs: Segment[] = (Object.entries(tv) as [HoldingType, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([tp, fmv]) => {
      const cnt = funds.reduce((n, f) => n + f.h.filter((h) => h.tp === tp).length, 0);
      return {
        label: TYPE_LABEL[tp] || tp,
        pct: (fmv / totalFMV) * 100,
        color: TYPE_COLORS[tp] || TYPE_COLORS.Equity,
        rows: [
          ['Unrealized Market Value', `${money(fmv)} · ${Math.round((fmv / totalFMV) * 100)}%`],
          ['Holdings', `${cnt} across ${funds.length} funds`],
        ],
      };
    });

  const segs = tab === 'fund' ? fundSegs : typeSegs;

  return (
    <div className="mb-4 rounded-lg border bg-card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <span className="text-xs font-medium text-foreground">Money breakdown</span>
        <div className="ml-auto inline-flex overflow-hidden rounded-full border bg-background">
          {(
            [
              ['fund', 'By fund'],
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
              <div className="mb-1.5 text-xs font-medium text-foreground">{s.label}</div>
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
            {s.label}
            <span className="text-muted-foreground/70"> · {Math.round(s.pct)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}
