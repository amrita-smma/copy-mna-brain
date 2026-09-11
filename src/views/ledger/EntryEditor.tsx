'use client';

import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { NumericInput } from '@/components/common/NumericInput';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import * as fundLedgerApi from '@/lib/api/fundLedger';
import type { FlPortfolioLedgerEntry } from '@/lib/api/fundLedger';
import {
  ENTRY_TYPE_KEYS,
  allowsPositionKind,
  applyEntryTypeChange,
  applyPositionChange,
  buildUpdateEventInput,
  cashIsLockedBySplit,
  deltaHint,
  editBlockedReason,
  entryEditRowHeader,
  entryTypeLabel,
  eventEditDraftFrom,
  eventEditProblem,
  editRowSubTypeControl,
  isDeltaLocked,
  isEventEditUnchanged,
  orderRowsForDisplay,
  positionIsEditable,
  positionLabel,
  positionOptionsForRow,
  priceIsDerived,
  valuationIsLocked,
  type EntryEditRow,
  type EventEditDraft,
  type FlEntryType,
  type LedgerIndex,
} from '@/lib/fundLedger';
import { EntityCombobox, type EntityOption } from './EntityCombobox';
import { FIELD_HINT, FIELD_INPUT, FIELD_LABEL, FIELD_TEXT, Term } from './parts';
import { useLedgerMoney } from './useLedgerMoney';
import {
  DESTINATION_TO_SUB_TYPE,
  SELL_PROCEEDS_DESTINATIONS,
  SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
  toDivestmentSubType,
  type SellProceedsDestination,
} from '@/lib/sellProceedsDestination';

const PROCEEDS_DESTINATION_LABELS: Record<SellProceedsDestination, string> = {
  cash_in_fund: 'Cash in fund',
  distributed_to_investor: 'Distributed to investor',
};

/** A compact labelled field. */
function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <Label htmlFor={id} className={FIELD_LABEL}>
        {label}
      </Label>
      <div className="mt-1">{children}</div>
      {hint && <div className={cn('mt-0.5', FIELD_HINT)}>{hint}</div>}
    </div>
  );
}

/** Money and unit fields: grouped as they are typed, right-aligned digits. */
const NUMERIC_INPUT = cn(FIELD_INPUT, 'font-mono tabular-nums');

/** One editable row of the event. */
function RowFields({
  row,
  index,
  highlight,
  disabled,
  nested = false,
  onChange,
}: {
  row: EntryEditRow;
  index: LedgerIndex;
  /** True for the row the user actually expanded. */
  highlight: boolean;
  disabled: boolean;
  nested?: boolean;
  onChange: (patch: Partial<EntryEditRow>) => void;
}) {
  const instrumentKind = row.positionInstrumentKind;
  const cashLocked = cashIsLockedBySplit(row);
  // A derived cash leg is regenerated from its primary row on save, so nothing
  // typed into it would survive — it is shown for context only.
  const derived = row.isDerivedCashLeg;
  const fieldsDisabled = disabled || derived;
  const fieldId = (name: string) => `ledger-edit-${row.id}-${name}`;
  const subTypeControl = editRowSubTypeControl(row);

  // Only the types this position's instrument can carry: the service rejects a
  // fund-only type on an asset position and vice versa.
  // A cash movement is never chosen by hand — it is either derived from another
  // row or posted as an opening balance — but a row that already is one still
  // needs its own value in the list, or the box renders blank.
  const typeOptions = ENTRY_TYPE_KEYS.filter(
    (candidate) =>
      (candidate !== 'cash_movement' || row.entryType === 'cash_movement') &&
      allowsPositionKind(candidate, instrumentKind),
  );

  // Which position the row hits is as much a data-entry mistake as its amount —
  // an imported row landing on the wrong holder is the common one — so it is
  // editable here rather than only fixable by deleting and re-posting.
  const positionEditable = positionIsEditable(row) && !fieldsDisabled;
  const positionOptions: EntityOption[] = useMemo(
    () =>
      positionOptionsForRow(
        { entryType: row.entryType, positionId: row.positionId },
        index,
      ).map((option) => ({
        key: option.id,
        name: option.sourceName ? `${option.name} · ${option.sourceName}` : option.name,
        group: option.group,
      })),
    [row.entryType, row.positionId, index],
  );

  const deltas: {
    key: 'commitmentDelta' | 'quantityDelta' | 'cashDelta';
    column: 'commitment' | 'quantity' | 'cash';
    label: string;
    term: string;
  }[] = [
    { key: 'commitmentDelta', column: 'commitment', label: 'Commitment Δ', term: 'commitdelta' },
    { key: 'quantityDelta', column: 'quantity', label: 'Quantity Δ', term: 'qtydelta' },
    { key: 'cashDelta', column: 'cash', label: 'Cash Δ', term: 'cashdelta' },
  ];

  return (
    <div
      className={cn(
        'rounded-md border bg-card p-3',
        highlight && 'border-primary/50 ring-1 ring-primary/20',
        nested && 'ml-4 sm:ml-6',
      )}
    >
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-[11px] font-medium">
          {entryEditRowHeader(row, index)}
        </div>
        <div className="font-mono text-[10px] text-muted-foreground">{row.id}</div>
      </div>

      {derived && (
        <div className="mb-2 rounded border bg-muted px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
          Cash leg derived from another row of this event. It is recalculated on
          save, so it cannot be edited here — change the row it mirrors instead.
        </div>
      )}

      {positionEditable ? (
        <div className="mb-2.5">
          <EntityCombobox
            id={fieldId('position')}
            label="Holder → what is held"
            hint={
              row.positionHasDeclaredSource
                ? 'the position this row hits; its declared pool funds the cash'
                : 'the position this row hits; moving it clears the funding split'
            }
            value={row.positionId}
            options={positionOptions}
            onChange={(positionId) =>
              onChange(applyPositionChange(row, positionId, index))
            }
          />
        </div>
      ) : (
        <div className="mb-2.5">
          <Label className={FIELD_LABEL}>Holder → what is held</Label>
          <div className={cn('mt-1 truncate text-[12px]', FIELD_TEXT)}>
            {positionLabel(row.positionId, index)}
          </div>
          <div className={cn('mt-0.5', FIELD_HINT)}>
            {derived
              ? 'follows the row it mirrors'
              : 'a cash movement stays on its own cash position'}
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 sm:grid-cols-4">
        <Field id={fieldId('type')} label="Type">
          <Select
            value={row.entryType}
            disabled={fieldsDisabled}
            onValueChange={(value) => {
              const entryType = value as FlEntryType;
              // A type that may not restate a value has to arrive at zero, or
              // the save would be blocked over a figure the user never typed.
              onChange({
                ...applyEntryTypeChange(row, entryType),
                ...(valuationIsLocked(entryType) ? { valuationDelta: '0' } : {}),
              });
            }}
          >
            <SelectTrigger id={fieldId('type')} className={FIELD_INPUT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {typeOptions.map((candidate) => (
                <SelectItem key={candidate} value={candidate} className={FIELD_TEXT}>
                  {entryTypeLabel(candidate)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {subTypeControl !== 'none' && (
          <Field
            id={fieldId('subtype')}
            label={subTypeControl === 'destination' ? 'Proceeds' : 'Sub-type'}
          >
            {subTypeControl === 'destination' ? (
              <Select
                value={
                  toDivestmentSubType(row.subType) ===
                  SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR
                    ? 'distributed_to_investor'
                    : 'cash_in_fund'
                }
                disabled={fieldsDisabled}
                onValueChange={(value) =>
                  onChange({
                    subType: DESTINATION_TO_SUB_TYPE[value as SellProceedsDestination],
                  })
                }
              >
                <SelectTrigger id={fieldId('subtype')} className={FIELD_INPUT}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SELL_PROCEEDS_DESTINATIONS.map((destination) => (
                    <SelectItem key={destination} value={destination} className={FIELD_TEXT}>
                      {PROCEEDS_DESTINATION_LABELS[destination]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id={fieldId('subtype')}
                className={FIELD_INPUT}
                value={row.subType}
                disabled={fieldsDisabled}
                placeholder="follow_on, mgmt_fee…"
                onChange={(event) => onChange({ subType: event.target.value })}
              />
            )}
          </Field>
        )}

        {/* Not editable: an event is denominated in the workspace display
            currency, the same one every figure on the Ledger reads in. */}
        <Field id={fieldId('currency')} label="Currency" hint="the reporting currency">
          <Input
            id={fieldId('currency')}
            className={cn(FIELD_INPUT, 'bg-muted uppercase')}
            value={row.currency}
            readOnly
            disabled
          />
        </Field>

        <Field id={fieldId('fx')} label="FX rate" hint="to the reporting currency">
          <NumericInput
            id={fieldId('fx')}
            className={NUMERIC_INPUT}
            value={row.fxRate}
            disabled={fieldsDisabled}
            placeholder="1"
            onChange={(value) => onChange({ fxRate: value })}
          />
        </Field>

        {deltas.map((delta) => {
          const locked = isDeltaLocked(row.entryType, delta.column);
          const lockedByCash = delta.column === 'cash' && cashLocked;
          return (
            <Field
              key={delta.key}
              id={fieldId(delta.key)}
              label={delta.label}
              hint={
                lockedByCash
                  ? `split across ${row.allocations.length} pools`
                  : deltaHint(row.entryType, delta.column)
              }
            >
              <NumericInput
                id={fieldId(delta.key)}
                className={NUMERIC_INPUT}
                value={locked ? '0' : row[delta.key]}
                disabled={fieldsDisabled || locked || lockedByCash}
                onChange={(value) => onChange({ [delta.key]: value })}
              />
            </Field>
          );
        })}

        <Field
          id={fieldId('price')}
          label="Price per unit"
          hint={priceIsDerived(row) ? 'blank — derived as cash ÷ units' : undefined}
        >
          <NumericInput
            id={fieldId('price')}
            className={NUMERIC_INPUT}
            value={row.pricePerUnit}
            disabled={fieldsDisabled}
            placeholder="—"
            onChange={(value) => onChange({ pricePerUnit: value })}
          />
        </Field>

        <Field
          id={fieldId('valuation')}
          label={row.subType === 'paid_in_writeoff' ? "Paid-in adjustment Δ" : "Valuation Δ"}
          hint={
            valuationIsLocked(row.entryType)
              ? 'only an adjustment may restate a value'
              : row.subType === 'paid_in_writeoff' ? 'changes paid-in capital without cash movement' : 'restates the carrying value'
          }
        >
          <NumericInput
            id={fieldId('valuation')}
            className={NUMERIC_INPUT}
            value={valuationIsLocked(row.entryType) ? '0' : row.valuationDelta}
            disabled={fieldsDisabled || valuationIsLocked(row.entryType)}
            onChange={(value) => onChange({ valuationDelta: value })}
          />
        </Field>

        <Field id={fieldId('status')} label="Status">
          <Select
            value={row.dataStatus}
            disabled={fieldsDisabled}
            onValueChange={(value) =>
              onChange({ dataStatus: value as EntryEditRow['dataStatus'] })
            }
          >
            <SelectTrigger id={fieldId('status')} className={FIELD_INPUT}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="verified" className={FIELD_TEXT}>
                Verified
              </SelectItem>
              <SelectItem value="needs_verification" className={FIELD_TEXT}>
                Needs checking
              </SelectItem>
            </SelectContent>
          </Select>
        </Field>

        <div className="col-span-2 min-w-0 sm:col-span-2">
          <Label htmlFor={fieldId('notes')} className={FIELD_LABEL}>
            Remarks
          </Label>
          <Textarea
            id={fieldId('notes')}
            rows={2}
            className={cn('mt-1 bg-background', FIELD_TEXT)}
            value={row.notes}
            disabled={fieldsDisabled}
            placeholder="Context the next person will need"
            onChange={(event) => onChange({ notes: event.target.value })}
          />
        </div>
      </div>

      {row.counterpartyPositionId && (
        <div className="mt-2 text-[10px] text-muted-foreground">
          Transfer leg against {positionLabel(row.counterpartyPositionId, index)}. Both legs must
          still cancel to zero.
        </div>
      )}
    </div>
  );
}

/**
 * The editable half of an expanded row.
 *
 * `PATCH /api/fund-ledger/events/:id` replaces the event by deleting it and
 * re-posting, so an edit is event-level: every row the event caused is shown
 * and saved together. That is not a UI convenience — a transfer's two legs have
 * to stay mirrored, and re-posting one without the other would be rejected.
 *
 * Field gating comes from the entry-type matrix, so a column the type may never
 * touch is disabled rather than offered and then refused with a 422.
 */
export function EntryEditor({
  entry,
  index,
  onSaved,
}: {
  entry: FlPortfolioLedgerEntry;
  index: LedgerIndex;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const money = useLedgerMoney();
  const [saving, setSaving] = useState(false);

  const event = entry.business_event_id ? index.events.get(entry.business_event_id) : undefined;
  const rows = useMemo(
    () =>
      entry.business_event_id
        ? (index.entriesByEvent.get(entry.business_event_id) ?? [entry])
        : [entry],
    [entry, index],
  );

  const original = useMemo(
    () => (event ? eventEditDraftFrom(event, rows, index, money.currency) : null),
    [event, rows, index, money.currency],
  );
  const [draft, setDraft] = useState<EventEditDraft | null>(original);

  // Re-seed whenever the underlying event changes — after a save, after a
  // reload elsewhere on the page — so the form never shows figures the ledger
  // has moved past.
  useEffect(() => {
    setDraft(original);
  }, [original]);

  if (!event || !original || !draft) {
    return (
      <div className="rounded-md border bg-card p-3 text-[11px] text-muted-foreground">
        This row is not attached to a business event, so it cannot be edited here.
      </div>
    );
  }

  const blocked = editBlockedReason(draft);
  const problem = eventEditProblem(draft);
  const unchanged = isEventEditUnchanged(draft, original);

  const displayRows = useMemo(
    () => orderRowsForDisplay(draft.rows),
    [draft.rows],
  );

  const patchRow = (id: string) => (patch: Partial<EntryEditRow>) =>
    setDraft((current) =>
      current
        ? {
            ...current,
            rows: current.rows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
          }
        : current,
    );

  const save = async () => {
    setSaving(true);
    try {
      await fundLedgerApi.updateEvent(draft.eventId, buildUpdateEventInput(draft));
      toast({
        title: 'Event updated',
        description:
          draft.rows.length > 1
            ? `All ${draft.rows.length} rows were saved.`
            : 'The row was saved.',
      });
      onSaved();
    } catch (error) {
      toast({
        title: 'Could not save the event',
        description: error instanceof Error ? error.message : 'Unexpected error',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0">
          <Label htmlFor={`ledger-edit-${draft.eventId}-date`} className={FIELD_LABEL}>
            Event date
          </Label>
          <Input
            id={`ledger-edit-${draft.eventId}-date`}
            type="date"
            className={cn(FIELD_INPUT, 'mt-1 w-[150px]')}
            value={draft.eventDate}
            disabled={!!blocked}
            onChange={(changeEvent) =>
              setDraft((current) =>
                current ? { ...current, eventDate: changeEvent.target.value } : current,
              )
            }
          />
          <div className={cn('mt-0.5', FIELD_HINT)}>applies to every row below</div>
        </div>
        <div className="min-w-0 flex-1">
          <Label htmlFor={`ledger-edit-${draft.eventId}-description`} className={FIELD_LABEL}>
            Description
          </Label>
          <Input
            id={`ledger-edit-${draft.eventId}-description`}
            className={cn(FIELD_INPUT, 'mt-1')}
            value={draft.description}
            disabled={!!blocked}
            placeholder="What happened, in one line"
            onChange={(changeEvent) =>
              setDraft((current) =>
                current ? { ...current, description: changeEvent.target.value } : current,
              )
            }
          />
        </div>
      </div>

      {blocked ? (
        <div className="rounded border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-relaxed text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {blocked}
        </div>
      ) : (
        <div className="rounded border bg-muted px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
          Saving replaces the whole{' '}
          <Term k="event">event</Term>
          {draft.rows.length > 1 ? ` and all ${draft.rows.length} of its rows` : ''} — the existing
          {draft.rows.length > 1 ? ' rows are' : ' row is'} deleted and re-posted under the same
          event, so the entry {draft.rows.length > 1 ? 'ids' : 'id'} will change and any report
          already run against {draft.rows.length > 1 ? 'them' : 'it'} will no longer reproduce. Any
          derived cash leg is recomputed from the rows above, so it follows what the fund and asset
          records say today.
        </div>
      )}

      <div className="space-y-2">
        {displayRows.map(({ row, isNested }) => (
          <RowFields
            key={row.id}
            row={row}
            index={index}
            nested={isNested}
            highlight={row.id === entry.id && draft.rows.length > 1}
            disabled={!!blocked || saving}
            onChange={patchRow(row.id)}
          />
        ))}
      </div>

      {!blocked && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto text-[11px] text-muted-foreground">
            {problem ?? (unchanged ? 'Nothing changed yet.' : 'Ready to save.')}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            disabled={unchanged || saving}
            onClick={() => setDraft(original)}
          >
            Reset
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={!!problem || unchanged || saving}
            onClick={() => void save()}
          >
            {saving ? 'Saving…' : 'Save event'}
          </Button>
        </div>
      )}
    </div>
  );
}
