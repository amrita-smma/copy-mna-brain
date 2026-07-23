'use client';

import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { Fund, Investor } from './types';
import { useFundMoney } from './useFundMoney';
import { DeleteRowMenu, GlossaryTerm, Pill, Chevron } from './parts';
import { TablePager } from './TablePager';
import { useFundData } from './context';
import { investorInvestedInFund } from './calc';

const PAGE_SIZE = 25;

const COLS: { label: string; term?: string; align: 'left' | 'right' }[] = [
  { label: 'Fund', align: 'left' },
  { label: 'Commitment', term: 'pledged', align: 'right' },
  { label: 'Invested', term: 'deployed', align: 'right' },
  { label: 'Unrealized Market Value', term: 'currentvalue', align: 'right' },
  { label: 'MOIC', term: 'returnmult', align: 'right' },
  { label: 'IRR', term: 'irr', align: 'right' },
  { label: 'Realized Value', term: 'cashreturned', align: 'right' },
  { label: 'DPI', term: 'dpiT', align: 'right' },
  { label: 'Phase', align: 'left' },
];

/** The "Fund" tab: an aggregate row per fund (expands to show per-investor breakdown). */
export function FundSummaryTable({
  funds,
  investors,
  onEditFund,
}: {
  funds: Fund[];
  investors: Investor[];
  onEditFund?: (fund: Fund) => void;
}) {
  const { deleteFund } = useFundData();
  const { money } = useFundMoney();
  const [page, setPage] = useState(1);
  const [openFunds, setOpenFunds] = useState<Set<string>>(new Set());

  const toggle = (id: string) => {
    const next = new Set(openFunds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpenFunds(next);
  };

  // Holdings are already scoped to each fund's transaction-level share (see
  // scopeHoldingToFund), so a fund's totals are just the sum of its holdings —
  // this reconciles with the header cards and the Asset / Investor / Source
  // tabs. Commitment / IRR / phase stay fund-level.
  const rows = funds
    .map((f) => {
      const invested = f.h.reduce((s, h) => s + h.cost, 0);
      const fmv = f.h.reduce((s, h) => s + h.fmv, 0);
      const real = f.h.reduce((s, h) => s + h.real, 0);
      return {
        f,
        invested,
        fmv,
        real,
        moic: invested > 0 ? (fmv + real) / invested : 0,
        dpiVal: invested > 0 ? real / invested : 0,
        calledPct: f.size > 0 ? (invested / f.size) * 100 : 0,
      };
    })
    .sort((a, b) => b.fmv - a.fmv);

  const start = (Math.min(page, Math.max(1, Math.ceil(rows.length / PAGE_SIZE))) - 1) * PAGE_SIZE;
  const pagedRows = rows.slice(start, start + PAGE_SIZE);

  return (
    <>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[900px] border-collapse">
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
                  No funds yet.
                </td>
              </tr>
            )}
            {pagedRows.map(({ f, invested, fmv, real, moic, dpiVal, calledPct }) => {
              const phaseTerm = f.st === 'Investing' ? 'investing' : 'harvesting';
              const isOpen = openFunds.has(f.id);
              const tableRows: ReactNode[] = [];

              tableRows.push(
                <tr 
                  key={f.id} 
                  onClick={() => toggle(f.id)}
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
                            toggle(f.id);
                          }}
                          className="flex h-6 w-6 items-center justify-center rounded-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        >
                          <Chevron open={isOpen} />
                        </button>
                        <div>
                          <div className="text-[13px] font-medium text-foreground">{f.n}</div>
                          <div className="mt-0.5">
                            <Pill>
                              <GlossaryTerm term="started">Started {f.v}</GlossaryTerm>
                            </Pill>
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {onEditFund && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onEditFund(f);
                            }}
                            className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                          >
                            ✎ edit
                          </button>
                        )}
                        <div onClick={(e) => e.stopPropagation()}>
                          <DeleteRowMenu
                            label="Delete fund"
                            title={`Delete "${f.n}"?`}
                            description={`This deletes the fund along with its commitment pledges and fund-level history. Its ${f.h.length} holding${f.h.length === 1 ? '' : 's'} and all their transactions are kept — they move to “Unassigned Assets”. This action cannot be undone.`}
                            onConfirm={() => deleteFund(f)}
                          />
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">{money(f.size)}</td>
                  <td className="px-3 py-2.5 text-right align-middle text-[13px] text-foreground">
                    {money(invested)}
                    <div className="text-[11px] text-muted-foreground">{calledPct.toFixed(0)}% invested</div>
                  </td>
                  <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">{money(fmv)}</td>
                  <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">{moic.toFixed(2)}×</td>
                  <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">
                    {f.irr > 0 ? '+' : ''}
                    {f.irr.toFixed(1)}%
                  </td>
                  <td className="px-3 py-2.5 text-right align-middle text-[13px] text-foreground">
                    {real > 0 ? money(real) : '—'}
                  </td>
                  <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">{dpiVal.toFixed(2)}×</td>
                  <td className="px-3 py-2.5 align-middle">
                    <Pill>
                      <GlossaryTerm term={phaseTerm}>{f.st}</GlossaryTerm>
                    </Pill>
                  </td>
                </tr>
              );

              if (isOpen && investors) {
                const relevantInvestors = investors.map((inv) => {
                  const committed = inv.stakes[f.id] || 0;
                  const s = f.size > 0 ? committed / f.size : 0;
                  const rawInvested = investorInvestedInFund(inv.id, f);
                  const invInvested = rawInvested > 0 ? rawInvested : invested * s;
                  const share = s > 0 ? s : (invested > 0 ? invInvested / invested : 0);
                  const invFmv = f.fmv * share;
                  const invReal = f.real * share;
                  const invMoic = invInvested > 0 ? (invFmv + invReal) / invInvested : 0;
                  const invDpi = invInvested > 0 ? invReal / invInvested : 0;

                  return {
                    inv,
                    s,
                    committed,
                    invInvested,
                    invFmv,
                    invReal,
                    invMoic,
                    invDpi
                  };
                }).filter(r => r.committed > 0 || r.invInvested > 0);

                if (relevantInvestors.length === 0) {
                  tableRows.push(
                    <tr key={`${f.id}-empty`} className="border-b">
                      <td colSpan={COLS.length} className="px-3 py-3 pl-10 text-[13px] text-muted-foreground bg-muted/10">
                        No investors committed.
                      </td>
                    </tr>
                  );
                } else {
                  relevantInvestors.forEach((r) => {
                    tableRows.push(
                      <tr key={`${f.id}-${r.inv.id}`} className="border-b [&>td]:bg-muted/10 hover:[&>td]:bg-background">
                        <td className="py-2 pl-3 pr-3 align-middle">
                          <div className="flex items-center">
                            <span className="w-5 shrink-0" />
                            <div className="border-l-2 border-border pl-2.5">
                              <div className="text-[13px] font-medium text-foreground">{r.inv.n}</div>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">{money(r.committed)}</td>
                        <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">{money(r.invInvested)}</td>
                        <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
                          {money(r.invFmv)}
                        </td>
                        <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
                          {`${r.invMoic.toFixed(2)}×`}
                        </td>
                        <td className="px-3 py-2 text-right align-middle text-[13px] text-muted-foreground">—</td>
                        <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
                          {r.invReal <= 0 ? '—' : money(r.invReal)}
                        </td>
                        <td className="px-3 py-2 text-right align-middle text-[13px] text-foreground">
                          {`${r.invDpi.toFixed(2)}×`}
                        </td>
                        <td className="px-3 py-2 align-middle text-[13px] text-muted-foreground">—</td>
                      </tr>
                    );
                  });
                }
              }

              return tableRows;
            })}
          </tbody>
        </table>
      </div>
      <TablePager
        page={page}
        pageSize={PAGE_SIZE}
        total={rows.length}
        onPageChange={setPage}
        itemLabel="fund"
      />
    </>
  );
}
