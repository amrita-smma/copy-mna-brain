'use client';

import { cn } from '@/lib/utils';
import type { Fund, Investor } from './types';
import { collectHoldingsByEntity, investorAgg, money, sourceAgg } from './calc';
import { DeleteRowMenu, GlossaryTerm, Pill } from './parts';

const COLS: { label: string; term?: string; align: 'left' | 'right' }[] = [
  { label: 'Investment Entity', align: 'left' },
  { label: 'Commitment', term: 'pledged', align: 'right' },
  { label: 'Invested', term: 'deployed', align: 'right' },
  { label: 'Unrealized Market Value', term: 'currentvalue', align: 'right' },
  { label: 'Net Gain', term: 'netgain', align: 'right' },
  { label: 'MOIC', term: 'returnmult', align: 'right' },
];

/** The "Investment Entity" tab: a read-only aggregate row per entity (no expand). */
export function EntitySummaryTable({
  funds,
  investors,
  onEditStakes,
  onDeleteInvestor,
}: {
  funds: Fund[];
  investors: Investor[];
  onEditStakes?: (investorId: string) => void;
  onDeleteInvestor?: (investorId: string) => Promise<void>;
}) {
  // Group every holding by its investing entity so each entity's performance
  // (Invested / Unrealized MV / Net Gain / MOIC) rolls up directly from the
  // assets — and therefore the transaction ledger — attributed to it, rather
  // than a pro-rata slice of the fund totals. Commitment stays stake-based: a
  // pledge isn't derivable from transactions.
  const byEntity = collectHoldingsByEntity(
    funds,
    investors.map((inv) => inv.n),
  );
  const rows = investors
    .map((inv) => {
      const items = byEntity.get(inv.n) ?? [];
      return {
        inv,
        commit: investorAgg(inv, funds).commit,
        a: sourceAgg(items),
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
            {rows.map(({ inv, commit, a }) => (
              <tr key={inv.id} className="border-b [&>td]:bg-card hover:[&>td]:bg-muted/40">
                <td className="px-3 py-2.5 align-middle">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-foreground">{inv.n}</span>
                      {onEditStakes && (
                        <button
                          type="button"
                          onClick={() => onEditStakes(inv.id)}
                          className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                        >
                          ✎ Edit
                        </button>
                      )}
                      {inv.type && <Pill>{inv.type}</Pill>}
                    </div>
                    {onDeleteInvestor && (
                      <DeleteRowMenu
                        label="Delete entity"
                        title={`Delete "${inv.n}"?`}
                        description="This removes the investment entity and its per-fund commitment/invested pledges. No assets or transactions are deleted — any holdings that named this entity will move to “Others”. This action cannot be undone."
                        onConfirm={() => onDeleteInvestor(inv.id)}
                      />
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
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-right text-[11px] text-muted-foreground">
        {rows.length} {rows.length === 1 ? 'entity' : 'entities'}
      </div>
    </>
  );
}
