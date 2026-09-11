'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { FlPortfolioLedgerEntry } from '@/lib/api/fundLedger';
import {
  allocationsBalance,
  allocationsOf,
  createSyntheticPosition,
  describeFromTo,
  entryTypeSpec,
  formatQuantity,
  formatQuantityAbs,
  partyKindLabel,
  positionLabel,
  transferLegProblem,
  type AllocationSplit,
  type LedgerIndex,
} from '@/lib/fundLedger';
import { flIsZero } from '@/lib/services/flDecimal';
import { FieldKey, Term, signClass } from './parts';
import { EntryEditor } from './EntryEditor';
import { useLedgerMoney } from './useLedgerMoney';

/** Distinct fills for the funding-split bar, reused by its legend swatches. */
const SPLIT_COLORS = [
  'bg-indigo-500',
  'bg-fuchsia-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-sky-500',
];

function Section({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-md border bg-background p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

function Note({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'ok' | 'bad';
}) {
  return (
    <div
      className={cn(
        'rounded border px-2.5 py-2 text-[11px] leading-relaxed',
        tone === 'ok' && 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300',
        tone === 'bad' && 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300',
        tone === 'neutral' && 'border-border bg-muted text-muted-foreground',
      )}
    >
      {children}
    </div>
  );
}

function FlowBox({
  label,
  name,
  meta,
  muted = false,
}: {
  label: ReactNode;
  name: string;
  meta: ReactNode;
  muted?: boolean;
}) {
  return (
    <div className={cn('min-w-0 flex-1 rounded border p-2.5', muted ? 'bg-muted' : 'bg-background')}>
      <FieldKey>{label}</FieldKey>
      <div className="mt-1 truncate text-[12px] font-medium" title={name}>
        {name}
      </div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">{meta}</div>
    </div>
  );
}

/**
 * The three-box strip at the top of an expanded row: where the money came from,
 * who moved it, and what it moved into — or, for a transfer, who gave up what
 * to whom.
 */
function FlowStrip({
  entry,
  index,
  splits,
}: {
  entry: FlPortfolioLedgerEntry;
  index: LedgerIndex;
  splits: AllocationSplit[];
}) {
  const money = useLedgerMoney();
  const position = index.positions.get(entry.position_id) ?? createSyntheticPosition(entry.position_id);

  if (entry.counterparty_position_id) {
    const flow = describeFromTo(entry, index);
    const movedPledge = !flIsZero(entry.commitment_delta ?? '0');
    return (
      <div className="flex flex-wrap items-stretch gap-2">
        <FlowBox label="Gives up" name={flow.from.name} meta={partyKindLabel(flow.from.kind)} />
        <div className="flex w-32 shrink-0 flex-col items-center justify-center px-2 text-center">
          <div className="text-lg leading-none text-muted-foreground">→</div>
          <div className="mt-1 text-[12px] font-medium">
            {movedPledge
              ? `${money.moneyAbs(entry.commitment_delta)} pledge`
              : `${formatQuantityAbs(entry.quantity_delta)} units`}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {flIsZero(entry.cash_delta ?? '0')
              ? 'no cash'
              : `${money.moneyAbs(entry.cash_delta)} consideration`}
          </div>
        </div>
        <FlowBox label="Receives" name={flow.to.name} meta={partyKindLabel(flow.to.kind)} />
        <FlowBox
          label="In"
          name={position.instrument.name}
          muted
          meta={
            <>
              <Term k="netzero">Legs net to zero</Term> · fund totals unchanged
            </>
          }
        />
      </div>
    );
  }

  const flow = describeFromTo(entry, index);
  const inflow = !flow.noCash && flow.fromIsInstrument;
  const sourceName = splits.length
    ? splits.map((split) => split.source.name).join(' + ')
    : 'Unattributed';
  const sourceMeta =
    splits.length > 1
      ? splits.map((split) => `${split.source.name} ${money.moneyAbs(split.amount)}`).join(' · ')
      : position.fundingSource
        ? 'declared on the position'
        : splits.length
          ? 'attributed on this entry'
          : 'no funding split recorded';

  return (
    <div className="flex flex-wrap items-stretch gap-2">
      <FlowBox
        label={<Term k="sourceoffund">Source of fund</Term>}
        name={sourceName}
        meta={sourceMeta}
      />
      <FlowBox
        label={<Term k="holder">Holder</Term>}
        name={position.holder.name}
        meta={partyKindLabel(position.holder.kind)}
      />
      <div className="flex w-32 shrink-0 flex-col items-center justify-center px-2 text-center">
        <div className="text-lg leading-none text-muted-foreground">
          {flow.noCash ? '⇢' : inflow ? '←' : '→'}
        </div>
        <div className={cn('mt-1 text-[12px] font-semibold', signClass(entry.cash_delta))}>
          {flow.noCash ? '—' : money.moneyAbs(entry.cash_delta)}
        </div>
        <div className="text-[10px] text-muted-foreground">
          {flow.noCash
            ? !flIsZero(entry.commitment_delta ?? '0')
              ? 'pledge only'
              : 'non-cash'
            : inflow
              ? 'received'
              : 'paid'}
        </div>
      </div>
      <FlowBox
        label={<Term k="instrument">What is held</Term>}
        name={position.instrument.name}
        meta={
          <>
            {partyKindLabel(position.instrument.kind)}
            {flIsZero(entry.quantity_delta ?? '0')
              ? ''
              : ` · ${formatQuantity(entry.quantity_delta)} units`}
          </>
        }
      />
    </div>
  );
}

function FundingSplit({
  entry,
  splits,
}: {
  entry: FlPortfolioLedgerEntry;
  splits: AllocationSplit[];
}) {
  const money = useLedgerMoney();
  if (splits.length === 0) {
    return (
      <div className="text-[11px] text-muted-foreground">
        {flIsZero(entry.cash_delta ?? '0')
          ? 'No cash moved, so there is nothing to attribute.'
          : 'Cash moved but no pool is named — the position declares no source, and none was attributed on the row.'}
      </div>
    );
  }

  const balanced = allocationsBalance(entry, splits);
  const total = splits.reduce((sum, split) => sum + Math.abs(Number(split.amount) || 0), 0);

  return (
    <div>
      <div className="mb-2 flex h-2 overflow-hidden rounded">
        {splits.map((split, splitIndex) => (
          <div
            key={split.source.id}
            className={SPLIT_COLORS[splitIndex % SPLIT_COLORS.length]}
            style={{ flex: Math.abs(Number(split.amount) || 0) || 1 }}
          />
        ))}
      </div>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
            <th className="py-1 text-left font-medium">Pool</th>
            <th className="py-1 text-left font-medium">Type</th>
            <th className="py-1 text-right font-medium">Amount</th>
            <th className="py-1 text-right font-medium">Share</th>
          </tr>
        </thead>
        <tbody>
          {splits.map((split, splitIndex) => {
            const amount = Math.abs(Number(split.amount) || 0);
            return (
              <tr key={split.source.id} className="border-t">
                <td className="py-1">
                  <span
                    className={cn(
                      'mr-1.5 inline-block h-2 w-2 rounded-sm align-middle',
                      SPLIT_COLORS[splitIndex % SPLIT_COLORS.length],
                    )}
                  />
                  {split.source.name}
                  {split.implied && (
                    <span className="ml-1 text-muted-foreground">(from the position)</span>
                  )}
                </td>
                <td className="py-1 text-muted-foreground">{split.source.sourceType ?? '—'}</td>
                <td className="py-1 text-right tabular-nums">{money.moneyAbs(split.amount)}</td>
                <td className="py-1 text-right tabular-nums">
                  {total > 0 ? `${Math.round((amount / total) * 100)}%` : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-2">
        <Note tone={balanced ? 'ok' : 'bad'}>
          {balanced
            ? `Splits add up to ${money.moneyAbs(entry.cash_delta)} — exactly the cash that moved.`
            : `Splits come to ${money.moneyAbs(String(total))} but ${money.moneyAbs(entry.cash_delta)} moved. This row would be rejected.`}
        </Note>
      </div>
    </div>
  );
}

/**
 * Everything behind one ledger row, shown when it is expanded: which way the
 * money went, the row's own signed deltas, how the cash was attributed, where
 * the row came from, and — for a transfer — the leg on the other side.
 */
export function EntryDetail({
  entry,
  index,
  onSaved,
}: {
  entry: FlPortfolioLedgerEntry;
  index: LedgerIndex;
  /** Re-fetch the read model after the event has been re-posted. */
  onSaved: () => void;
}) {
  const position = index.positions.get(entry.position_id);
  const splits = allocationsOf(entry, index);
  const spec = entryTypeSpec(entry.entry_type);
  const legProblem = transferLegProblem(entry, index);


  return (
    <div className="space-y-3">
      <FlowStrip entry={entry} index={index} splits={splits} />

      <Section
        label={
          <>
            Configure this event{' '}
            <span className="font-normal normal-case tracking-normal text-muted-foreground">
              — signs read from the <Term k="perspective">holder&rsquo;s point of view</Term>
              {spec ? `; ${spec.blurb.toLowerCase()}` : ''}
            </span>
          </>
        }
      >
        <EntryEditor entry={entry} index={index} onSaved={onSaved} />
      </Section>

      <Section label={<Term k="allocation">Funding split</Term>}>
        <FundingSplit entry={entry} splits={splits} />
      </Section>

      <Section label="Where it came from">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <FieldKey>
              <Term k="event">Event</Term>
            </FieldKey>
            <div className="mt-0.5 text-[12px]">{entry.event?.description ?? '—'}</div>
            <div className="font-mono text-[10px] text-muted-foreground">
              {entry.business_event_id ?? '—'}
            </div>
          </div>
          <div>
            <FieldKey>
              <Term k="position">Position</Term>
            </FieldKey>
            <div className="mt-0.5 text-[12px]">{positionLabel(entry.position_id, index)}</div>
            <div className="font-mono text-[10px] text-muted-foreground">
              {entry.position_id}
              {position?.fundingSource
                ? ` · ${position.fundingSource.name}`
                : ' · no declared source'}
            </div>
          </div>
          <div>
            <FieldKey>
              {entry.source_record_id ? <Term k="provenance">Source row</Term> : 'Entered by'}
            </FieldKey>
            {entry.source_record_id ? (
              <>
                <div className="mt-0.5 text-[12px]">Imported from a spreadsheet</div>
                <div className="font-mono text-[10px] text-muted-foreground">
                  {entry.source_record_id}
                </div>
              </>
            ) : (
              <>
                <div className="mt-0.5 text-[12px]">Posted in app</div>
                <div className="text-[10px] text-muted-foreground">no spreadsheet origin</div>
              </>
            )}
          </div>
        </div>
      </Section>

      {entry.counterparty_position_id && (
        <Section label={<Term k="counterparty">Other leg</Term>}>
          <div className="text-[12px]">
            {positionLabel(entry.counterparty_position_id, index)}{' '}
            <span className="font-mono text-[10px] text-muted-foreground">
              {entry.counterparty_position_id}
            </span>
          </div>
          <div className="mt-2">
            {legProblem ? (
              <Note tone="bad">{legProblem}.</Note>
            ) : (
              <div className="text-[11px] text-muted-foreground">
                Same event, mirrored deltas — they cancel, so the fund&rsquo;s totals are
                unchanged. Neither leg can be posted alone.
              </div>
            )}
          </div>
        </Section>
      )}
    </div>
  );
}
