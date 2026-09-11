'use client';

import type { ReactNode } from 'react';
import { formatDateShort, type LedgerSummary } from '@/lib/fundLedger';
import { Term } from './parts';
import { useLedgerMoney } from './useLedgerMoney';

function MetricCard({
  label,
  value,
  sub,
}: {
  label: ReactNode;
  value: string;
  sub: ReactNode;
}) {
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">{sub}</div>
    </div>
  );
}

/**
 * The four headline figures.
 *
 * Cash in and out, and the flagged-row count, total the rows currently in view.
 * Undrawn commitment does not: it counts from inception to the as-of date, so
 * narrowing the range or adding a filter never changes what has been pledged.
 */
export function LedgerMetrics({
  summary,
  asOf,
  from,
  filtered,
}: {
  summary: LedgerSummary;
  asOf: string;
  from: string | null;
  filtered: boolean;
}) {
  const money = useLedgerMoney();
  const scope =
    (from ? `since ${formatDateShort(from)}` : 'since inception') + (filtered ? ', filtered' : '');

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <MetricCard
        label="Cash out"
        value={money.moneyAbs(summary.cashOut)}
        sub={`${summary.cashOutRows} row${summary.cashOutRows === 1 ? '' : 's'} ${scope}`}
      />
      <MetricCard
        label="Cash in"
        value={money.moneyAbs(summary.cashIn)}
        sub={`${summary.cashInRows} row${summary.cashInRows === 1 ? '' : 's'} ${scope}`}
      />
      <MetricCard
        label={<Term k="opencommit">Undrawn commitment</Term>}
        value={money.moneyAbs(summary.undrawn)}
        sub={
          <>
            {money.moneyAbs(summary.commitment)} pledged · <Term k="asof">as of</Term>{' '}
            {formatDateShort(asOf)}
          </>
        }
      />
      <MetricCard
        label={<Term k="needsverif">Needs checking</Term>}
        value={String(summary.needsChecking)}
        sub={
          summary.needsChecking
            ? `of ${summary.windowRows} rows ${scope}`
            : `no flagged rows ${scope}`
        }
      />
    </div>
  );
}
