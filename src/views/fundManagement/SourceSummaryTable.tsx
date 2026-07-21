'use client';

import { cn } from '@/lib/utils';
import type { Fund } from './types';
import { aggregateByTxn, getAssetFundingSources } from './calc';
import { useFundMoney } from './useFundMoney';
import { DeleteRowMenu, GlossaryTerm, Pill } from './parts';
import { useFundData } from './context';

const COLS: { label: string; term?: string; align: 'left' | 'right' }[] = [
  { label: 'Source of Fund', term: 'fundingsource', align: 'left' },
  { label: 'Invested', term: 'deployed', align: 'right' },
  { label: 'Unrealized Market Value', term: 'currentvalue', align: 'right' },
  { label: 'Net Gain', term: 'netgain', align: 'right' },
  { label: 'MOIC', term: 'returnmult', align: 'right' },
];

/** The "Source of Fund" tab: a read-only aggregate row per capital pool (no expand). */
export function SourceSummaryTable({
  funds,
  sourceNames = [],
  sourceIdsByName,
  onDeleteSource,
  onEditSource,
}: {
  funds: Fund[];
  sourceNames?: string[];
  /** Maps a managed source name to its funding_sources row id. Only sources
   * present here (i.e. in the managed list) get edit/delete actions — free-text /
   * in-use-only and "Unspecified" sources have no row to edit or delete. */
  sourceIdsByName?: Map<string, string>;
  onDeleteSource?: (sourceId: string) => Promise<void>;
  onEditSource?: (sourceId: string, currentName: string) => void;
}) {
  const { sourceNameById } = useFundData();
  const { money } = useFundMoney();
  // Roll each source up from the transaction ledger: every transaction is
  // attributed to its own funding source (`txn.fundingSourceId`), falling back
  // to the asset's source when it names none, so a single asset can split across
  // pools. Then seed any managed source with no holdings yet so a freshly-added
  // Source of Fund shows up immediately (empty group).
  const bySource = aggregateByTxn(
    funds,
    (t, h) =>
      t.fundingSourceId
        ? sourceNameById.get(t.fundingSourceId) ?? getAssetFundingSources(h)[0]
        : getAssetFundingSources(h)[0],
    (h) => getAssetFundingSources(h),
  );
  sourceNames.forEach((name) => {
    if (name && !bySource.has(name)) bySource.set(name, { cost: 0, fmv: 0, real: 0, gain: 0, moic: 0, count: 0 });
  });
  const rows = [...bySource.entries()]
    .map(([src, a]) => ({ src, a }))
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
                  No sources of fund yet.
                </td>
              </tr>
            )}
            {rows.map(({ src, a }) => {
              const sourceId = sourceIdsByName?.get(src);
              return (
              <tr key={src} className="border-b [&>td]:bg-card hover:[&>td]:bg-muted/40">
                <td className="px-3 py-2.5 align-middle">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-foreground">{src}</span>
                      {onEditSource && sourceId && (
                        <button
                          type="button"
                          onClick={() => onEditSource(sourceId, src)}
                          className="text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                        >
                          ✎ Edit
                        </button>
                      )}
                      <Pill>
                        {a.count} holding{a.count === 1 ? '' : 's'}
                      </Pill>
                    </div>
                    {onDeleteSource && sourceId && (
                      <DeleteRowMenu
                        label="Delete source"
                        title={`Delete "${src}"?`}
                        description="This removes the source of fund from your managed list. No assets or transactions are deleted — holdings that named this source stay, shown as an in-use source until you re-tag them. This action cannot be undone."
                        onConfirm={() => onDeleteSource(sourceId)}
                      />
                    )}
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">{money(a.cost)}</td>
                <td className="px-3 py-2.5 text-right align-middle text-[13px] font-medium text-foreground">
                  {a.fmv > 0 ? money(a.fmv) : '—'}
                </td>
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
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-2 text-right text-[11px] text-muted-foreground">
        {rows.length} source{rows.length === 1 ? '' : 's'}
      </div>
    </>
  );
}
