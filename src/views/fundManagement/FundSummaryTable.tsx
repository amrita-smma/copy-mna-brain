'use client';

import { cn } from '@/lib/utils';
import type { Fund } from './types';
import { money } from './calc';
import { DeleteRowMenu, GlossaryTerm, Pill } from './parts';
import { useFundData } from './context';

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

/** The "Fund" tab: a read-only summary row per fund (no expand). */
export function FundSummaryTable({
  funds,
  onEditFund,
}: {
  funds: Fund[];
  onEditFund?: (fund: Fund) => void;
}) {
  const { deleteFund } = useFundData();

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
            {rows.map(({ f, invested, fmv, real, moic, dpiVal, calledPct }) => {
              const phaseTerm = f.st === 'Investing' ? 'investing' : 'harvesting';
              return (
                <tr key={f.id} className="border-b [&>td]:bg-card hover:[&>td]:bg-muted/40">
                  <td className="px-3 py-2.5 align-middle">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <div className="text-[13px] font-medium text-foreground">{f.n}</div>
                        <div className="mt-0.5">
                          <Pill>
                            <GlossaryTerm term="started">Started {f.v}</GlossaryTerm>
                          </Pill>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {onEditFund && (
                          <button
                            type="button"
                            onClick={() => onEditFund(f)}
                            className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                          >
                            ✎ edit
                          </button>
                        )}
                        <DeleteRowMenu
                          label="Delete fund"
                          title={`Delete "${f.n}"?`}
                          description={`This deletes the fund along with its commitment pledges and fund-level history. Its ${f.h.length} holding${f.h.length === 1 ? '' : 's'} and all their transactions are kept — they move to “Unassigned Assets”. This action cannot be undone.`}
                          onConfirm={() => deleteFund(f)}
                        />
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
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-right text-[11px] text-muted-foreground">
        {rows.length} fund{rows.length === 1 ? '' : 's'}
      </div>
    </>
  );
}
