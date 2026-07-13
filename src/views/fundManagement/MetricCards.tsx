'use client';

import { cn } from '@/lib/utils';
import type { Fund } from './types';
import { growth, holdingsPortfolioTotals, money } from './calc';
import { DeltaBadge, GlossaryTerm } from './parts';

interface MetricCardsProps {
  funds: Fund[];
}

/** Section (a): the four portfolio summary cards across the top. */
export function MetricCards({ funds }: MetricCardsProps) {
  // Sum Invested / Unrealized MV / Realized from the holdings (i.e. the ledger)
  // rather than fund-level rollups, so the header ties out to every grouping —
  // including assets under the synthetic "Unassigned Assets" fund.
  const t = holdingsPortfolioTotals(funds);
  const cards = [
    {
      key: 'pledged',
      label: 'Total Commitment',
      value: money(t.commitment),
      // Investor count is left out here — the Investor tab has no backend
      // yet (see FundManagement.tsx), so it's still static mock data and
      // can't be mixed into an otherwise real, API-backed metric.
      sub: `${funds.length} fund${funds.length === 1 ? '' : 's'}`,
      delta: growth(t.committedHist),
      accent: false,
    },
    {
      key: 'deployed',
      label: 'Total Invested',
      value: money(t.invested),
      sub: t.commitment
        ? `${Math.round((t.invested / t.commitment) * 100)}% of commitment invested`
        : '—',
      delta: growth(t.calledHist),
      accent: false,
    },
    {
      key: 'currentvalue',
      label: 'Unrealized Market Value',
      value: money(t.fmv),
      sub: `plus ${money(t.real)} realized value`,
      delta: growth(t.fmvHist),
      accent: false,
    },
    {
      key: 'moic',
      label: 'MOIC',
      value: `${t.moic.toFixed(2)}×`,
      sub: 'MOIC across all funds',
      delta: growth(t.tvpiHist),
      accent: true,
    },
  ];

  return (
    <div className="mb-3.5 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
      {cards.map((c) => (
        <div
          key={c.key}
          className={cn(
            'rounded-lg border bg-card p-3',
            c.accent && 'border-accent/40',
          )}
        >
          <div className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            <GlossaryTerm term={c.key}>{c.label}</GlossaryTerm>
          </div>
          <div
            className={cn(
              'text-xl font-medium leading-tight',
              c.accent ? 'text-accent' : 'text-foreground',
            )}
          >
            {c.value}
          </div>
          <div className="mt-1.5">
            <DeltaBadge pct={c.delta} />
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">{c.sub}</div>
        </div>
      ))}
    </div>
  );
}
