'use client';

import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { Fund, Investor } from './types';
import { investorInvestedInFund } from './calc';
import { useFundMoney } from './useFundMoney';
import { DeleteRowMenu, GlossaryTerm, Pill, Chevron } from './parts';
import { InlineCommitmentHistory } from './CommitmentHistoryTable';

const COLS: { label: string; term?: string; align: 'left' | 'right' }[] = [
  { label: 'Investment Entity', align: 'left' },
  { label: 'Commitment', term: 'pledged', align: 'right' },
  { label: 'Invested', term: 'deployed', align: 'right' },
  { label: 'Unrealized Market Value', term: 'currentvalue', align: 'right' },
  { label: 'Net Gain', term: 'netgain', align: 'right' },
  { label: 'MOIC', term: 'returnmult', align: 'right' },
];

/** The "Investment Entity" tab: an aggregate row per entity (expands to show per-fund breakdown). */
export function EntitySummaryTable({
  funds,
  investors,
  onEditStakes,
  onDeleteInvestor,
  commitmentNonce,
}: {
  funds: Fund[];
  investors: Investor[];
  onEditStakes?: (investorId: string, fundId?: string) => void;
  onDeleteInvestor?: (investorId: string) => Promise<void>;
  commitmentNonce?: number;
}) {
  const { money } = useFundMoney();
  const [openInvestors, setOpenInvestors] = useState<Set<string>>(new Set());
  const [openFundHistories, setOpenFundHistories] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    const next = new Set(openInvestors);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpenInvestors(next);
  };

  const toggleFundHistory = (key: string) => {
    setOpenFundHistories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const rows = investors
    .map((inv) => {
      let cost = 0;
      let fmv = 0;
      let real = 0;
      let commit = 0;
      
      funds.forEach((f) => {
        const committed = inv.stakes[f.id] || 0;
        commit += committed;
        const s = f.size > 0 ? committed / f.size : 0;
        const fundInvested = f.h.reduce((acc, h) => acc + h.cost, 0);
        const rawInvested = investorInvestedInFund(inv.id, f);
        const invested = rawInvested > 0 ? rawInvested : fundInvested * s;
        
        if (committed > 0 || invested > 0) {
          const share = s > 0 ? s : (fundInvested > 0 ? invested / fundInvested : 0);
          cost += invested;
          fmv += f.fmv * share;
          real += f.real * share;
        }
      });
      
      const gain = fmv + real - cost;
      const moic = cost > 0 ? (fmv + real) / cost : 0;
      
      return {
        inv,
        commit,
        a: { cost, fmv, real, gain, moic, count: 0 },
      };
    })
    .sort((x, y) => y.a.fmv - x.a.fmv);

  return (
    <>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[640px] border-collapse">
          <thead>
            <tr>
              {COLS.map((c) => (
                <th
                  key={c.label}
                  className={cn(
                    'whitespace-nowrap border-b bg-muted/50 px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground',
                    c.align === 'right' ? 'text-right' : 'text-left',
                  )}
                >
                  {c.term ? <GlossaryTerm term={c.term}>{c.label}</GlossaryTerm> : c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={COLS.length} className="px-3 py-10 text-center text-sm text-muted-foreground">
                  No investment entities yet.
                </td>
              </tr>
            )}
            {rows.map(({ inv, commit, a }) => {
              const isOpen = openInvestors.has(inv.id);
              const tableRows: ReactNode[] = [];
              
              tableRows.push(
                <tr 
                  key={inv.id} 
                  onClick={() => toggle(inv.id)}
                  className={cn(
                    'cursor-pointer border-b [&>td]:bg-card hover:[&>td]:bg-muted/40',
                    isOpen && '[&>td]:!bg-accent/10'
                  )}
                >
                  <td className="px-3 py-2.5 align-middle">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          aria-expanded={isOpen}
                          onClick={(e) => {
                            e.stopPropagation();
                            toggle(inv.id);
                          }}
                          className="flex h-6 w-6 items-center justify-center rounded-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          <Chevron open={isOpen} />
                        </button>
                        <span className="text-[13px] font-medium text-foreground">{inv.n}</span>
                        {onEditStakes && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onEditStakes(inv.id);
                            }}
                            className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                          >
                            ✎ Edit
                          </button>
                        )}
                        {inv.type && <Pill>{inv.type}</Pill>}
                      </div>
                      {onDeleteInvestor && (
                        <div onClick={(e) => e.stopPropagation()}>
                          <DeleteRowMenu
                            label="Delete entity"
                            title={`Delete "${inv.n}"?`}
                            description="This removes the investment entity and its per-fund commitment/invested pledges. No assets or transactions are deleted — any holdings that named this entity will move to “Others”. This action cannot be undone."
                            onConfirm={() => onDeleteInvestor(inv.id)}
                          />
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">{money(commit)}</td>
                  <td className="px-3 py-2.5 text-right align-middle text-[13px] text-foreground">{money(a.cost)}</td>
                  <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">{money(a.fmv)}</td>
                  <td
                    className={cn(
                      'px-3 py-2.5 text-right align-middle text-[13px] font-medium',
                      a.gain >= 0 ? 'text-success' : 'text-destructive',
                    )}
                  >
                    {a.gain >= 0 ? '+' : '−'}
                    {money(Math.abs(a.gain))}
                  </td>
                  <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">{a.moic.toFixed(2)}×</td>
                </tr>
              );

              if (isOpen) {
                // Determine funds this investor is part of
                const relevantFunds = funds.map((f) => {
                  const committed = inv.stakes[f.id] || 0;
                  const s = f.size > 0 ? committed / f.size : 0;
                  const fundInvested = f.h.reduce((acc, h) => acc + h.cost, 0);
                  const rawInvested = investorInvestedInFund(inv.id, f);
                  const invested = rawInvested > 0 ? rawInvested : fundInvested * s;
                  const share = s > 0 ? s : (fundInvested > 0 ? invested / fundInvested : 0);
                  const fmv = f.fmv * share;
                  const real = f.real * share;
                  const gain = fmv + real - invested;
                  const moic = invested > 0 ? (fmv + real) / invested : 0;
                  
                  return {
                    f,
                    committed,
                    invested,
                    fmv,
                    real,
                    gain,
                    moic
                  };
                }).filter(r => r.committed > 0 || r.invested > 0);

                if (relevantFunds.length === 0) {
                  tableRows.push(
                    <tr key={`${inv.id}-empty`} className="border-b">
                      <td colSpan={COLS.length} className="px-3 py-3 pl-10 text-[13px] text-muted-foreground bg-muted/10">
                        No funds committed.
                      </td>
                    </tr>
                  );
                } else {
                  relevantFunds.forEach((r) => {
                    const historyKey = `${inv.id}-${r.f.id}`;
                    const isHistoryOpen = openFundHistories.has(historyKey);

                    tableRows.push(
                      <tr
                        key={historyKey}
                        onClick={() => toggleFundHistory(historyKey)}
                        className={cn(
                          'cursor-pointer border-b [&>td]:bg-muted/10 hover:[&>td]:bg-background',
                          isHistoryOpen && '[&>td]:!bg-accent/10',
                        )}
                      >
                        <td className="py-2 pl-3 pr-3 align-middle">
                          <div className="flex items-center">
                            <span className="w-5 shrink-0" />
                            <span className="mr-1.5 w-3 shrink-0 text-[11px] text-muted-foreground">
                              {isHistoryOpen ? '▾' : '▸'}
                            </span>
                            <div className="flex items-center gap-2 border-l-2 border-border pl-2.5">
                              <span className="text-[13px] font-medium text-foreground">{r.f.n}</span>
                              <button
                                type="button"
                                aria-expanded={isHistoryOpen}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleFundHistory(historyKey);
                                }}
                                className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                              >
                                Commitment history
                              </button>
                              {onEditStakes && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onEditStakes(inv.id, r.f.id);
                                  }}
                                  className="text-[10px] text-muted-foreground hover:text-foreground hover:underline"
                                >
                                  ✎ Edit
                                </button>
                              )}
                            </div>
                          </div>
                        </td>

                        <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">{money(r.committed)}</td>
                        <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">{money(r.invested)}</td>
                        <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
                          {money(r.fmv)}
                        </td>
                        <td
                          className={cn(
                            'px-3 py-2 text-right align-middle text-[13px]',
                            r.gain >= 0
                              ? 'text-success'
                              : 'text-destructive',
                          )}
                        >
                          {`${r.gain >= 0 ? '+' : '−'}${money(Math.abs(r.gain))}`}
                        </td>
                        <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
                          {`${r.moic.toFixed(2)}×`}
                        </td>
                      </tr>
                    );

                    if (isHistoryOpen) {
                      tableRows.push(
                        <tr key={`${historyKey}-history`} className="border-b">
                          <td colSpan={COLS.length} className="bg-background px-4 py-3">
                            <div className="pl-6">
                              <InlineCommitmentHistory
                                fundId={r.f.id}
                                fundName={r.f.n}
                                holdingEntityId={inv.id}
                                investorName={inv.n}
                                refreshKey={`${r.committed}-${commitmentNonce ?? 0}`}
                                onOpenDialog={onEditStakes ? () => onEditStakes(inv.id, r.f.id) : undefined}
                              />
                            </div>
                          </td>
                        </tr>
                      );
                    }
                  });
                }
              }

              return tableRows;
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-right text-[11px] text-muted-foreground">
        {rows.length} {rows.length === 1 ? 'entity' : 'entities'}
      </div>
    </>
  );
}
