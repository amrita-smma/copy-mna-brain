/**
 * Editing a posted event via updateEvent.
 *
 * `FlLedgerService.updateEvent` updates the event in place: the event ID and
 * 'posted' status are preserved, no reversal event is created, and pre-edit
 * state is snapshotted into revisions. An edit is **event-level**: all entries
 * are replaced under the same business event ID. That is why this model carries
 * all of them, and why the editor shows them all rather than pretending a single
 * row can be amended on its own — a transfer's two legs have to stay mirrored or
 * neither posts.
 *
 * Unlike the posting form, which asks "how much" and derives the signs, this
 * editor shows the signed deltas as stored and validates them against the
 * entry-type matrix. Someone correcting imported data is working with the
 * numbers as the ledger holds them, not re-deciding what kind of movement it
 * was.
 */

import type { LedgerEntryInput, UpdateEventInput } from '@/lib/api/fundLedger';
import type { FlPortfolioLedgerEntry } from '@/lib/services/flPortfolioService';
import type { Tables } from '@/lib/repositories';
import { flIsZero, toDecimalString } from '@/lib/services/flDecimal';
import {
  allowsPositionKind,
  ENTRY_TYPES,
  entryTypeLabel,
  type FlEntryType,
} from './entryTypes';
import { satisfiesRuleDecimal } from './postDraft';
import {
  SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
  isDivestmentSubType,
  toDivestmentSubType,
} from '@/lib/sellProceedsDestination';
import {
  demoteProceedsTreatment,
  isProceedsTreatmentApplicable,
  subTypeControlFor,
} from './proceedsTreatment';
import {
  positionDirectionLabel,
  positionLabel,
  type LedgerIndex,
} from './derive';

/** One row of the event, as the editor holds it. */
export interface EntryEditRow {
  /** The existing entry id — for React keys and for labelling only. */
  id: string;
  positionId: string;
  entryType: FlEntryType;
  subType: string;
  /** Signed deltas, exactly as stored, as the strings the user is editing. */
  commitmentDelta: string;
  quantityDelta: string;
  cashDelta: string;
  /**
   * The restated carrying value, editable only on an `adjustment`.
   *
   * Every other type is required to leave it at zero, so the field is locked
   * rather than offered and then refused — but updating replaces the event's
   * entries, so whatever it holds is always sent back or it would be lost.
   */
  valuationDelta: string;
  currency: string;
  fxRate: string;
  pricePerUnit: string;
  counterpartyPositionId: string | null;
  dataStatus: 'verified' | 'needs_verification';
  notes: string;
  /** True for a row posted by the reversal path — such events cannot be edited. */
  isReversal: boolean;
  /**
   * True for a cash leg the service generated from another row of this event.
   *
   * `postEvent` derives these itself, so a replacement must not send them back:
   * a mirrored `cash_movement` is paired to its primary by a transient
   * `primary_entry_index` that exists only inside the request that created it,
   * and re-posting one without it is rejected. The row is shown read-only and
   * left out of the payload — the service derives it again.
   */
  isDerivedCashLeg: boolean;
  /**
   * The entry this derived cash leg mirrors, when it is one.
   *
   * Display-only: used to sit a derived leg beneath the row it mirrors in the
   * editor, and is never sent back in the update payload.
   */
  sourceLedgerEntryId: string | null;
  /**
   * Whether the position declares a single source of fund.
   *
   * Decides what happens to the funding split on save. A sourced position gets
   * one allocation for the whole amount, recreated by the service — so cash
   * stays editable. An unsourced one carries the split on the entry, and a
   * re-post would drop it unless it is sent back verbatim.
   */
  positionHasDeclaredSource: boolean;
  /**
   * What the row's position holds, so the entry-type matrix can be checked
   * without reaching back into the index.
   *
   * Carried on the row because the position itself is editable: the type and
   * the position each constrain the other, and the service rejects the pair
   * with `EntryPositionKindMismatchError` only after the old entries have
   * already been deleted inside its transaction.
   */
  positionInstrumentKind: 'fund' | 'asset' | 'unknown';
  /** Holder classification used by the same proceeds policy as new-entry posting. */
  positionHolderKind: 'investor' | 'managed_fund' | 'unmanaged_fund' | 'unknown';
  positionHolderId: string | null;
  /** True when the row's position is closed — such a position refuses entries. */
  positionIsClosed: boolean;
  /** The split as recorded, preserved across the replacement. */
  allocations: { fundingSourceId: string; amount: string }[];
}

/**
 * True when this row is a cash leg the service derives for itself.
 *
 * Mirrors the service's own rule: a `cash_movement` that is neither an opening
 * balance nor one half of an FX transfer has to carry a `primary_entry_index`,
 * a within-request reference the editor cannot reconstruct. Such a row is
 * always generated, so it is dropped from the replacement and regenerated.
 */
export function isDerivedCashLegRow(row: {
  entryType: FlEntryType;
  subType: string;
  counterpartyPositionId: string | null;
}): boolean {
  return (
    row.entryType === 'cash_movement' &&
    !row.counterpartyPositionId &&
    row.subType.trim() !== 'opening_balance'
  );
}

/**
 * True when this row's cash amount cannot be edited.
 *
 * An entry-level split has to add up to the cash that moved. Since this editor
 * preserves the split verbatim rather than offering a way to re-apportion it,
 * changing the cash would post an event the service rejects — so the field is
 * locked and the reason is shown instead.
 */
export function cashIsLockedBySplit(row: EntryEditRow): boolean {
  return !row.positionHasDeclaredSource && row.allocations.length > 0;
}

/**
 * True when this row's position can be repointed.
 *
 * A derived cash leg is regenerated on save, so moving it would be undone. A
 * `cash_movement` is pinned to one currency's cash position — the service
 * checks the asset is `asset_kind = 'cash'` and that its currency matches, and
 * neither is a choice the editor can offer meaningfully — so it stays put too.
 */
export function positionIsEditable(row: EntryEditRow): boolean {
  return !row.isDerivedCashLeg && row.entryType !== 'cash_movement';
}

/** One position the row could be moved to. */
export interface PositionOption {
  id: string;
  /** "Holder → what is held". */
  name: string;
  /** Grouped by holder, so two positions on the same holder sit together. */
  group: string;
  /** Its declared pool, or null when the split lives on each entry instead. */
  sourceName: string | null;
}

/**
 * The positions this row could be repointed to.
 *
 * Only positions whose instrument the row's entry type may sit on, and only
 * open ones — both are conditions the service enforces. The row's current
 * position is always included even when it fails them, or the box would render
 * blank on a row that is already in that state.
 */
export function positionOptionsForRow(
  row: Pick<EntryEditRow, 'entryType' | 'positionId'>,
  index: LedgerIndex,
): PositionOption[] {
  const options: PositionOption[] = [];
  for (const position of index.positions.values()) {
    const current = position.id === row.positionId;
    if (!current) {
      if (!position.resolution.isResolved) continue;
      if (position.status === 'closed') continue;
      if (!allowsPositionKind(row.entryType, position.instrumentKind)) continue;
    }
    options.push({
      id: position.id,
      name: `${position.holder.name} → ${position.instrument.name}`,
      group: position.holder.name,
      sourceName: position.fundingSource?.name ?? null,
    });
  }
  return options.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The patch that moves a row onto another position.
 *
 * More than the id changes. `positionHasDeclaredSource` decides whether the
 * funding split is sent back or left to the service to recreate, and the
 * preserved `allocations` describe the *old* position's pools — sending them
 * against a position that declares its own source is rejected with
 * `AllocationSourceMismatchError`, and against an unrelated unsourced position
 * they would attribute the cash to a pool that has nothing to do with it. So
 * the split is dropped: the service recreates it from the new position's
 * declared source, or the row lands unattributed and the funding split panel
 * says so.
 */
export function applyPositionChange(
  row: EntryEditRow,
  positionId: string,
  index: LedgerIndex,
): Partial<EntryEditRow> {
  const position = index.positions.get(positionId);
  const positionHolderKind = holderKindForPosition(position);
  const control = subTypeControlFor({
    entryType: row.entryType,
    holder: cashHolderForEdit(positionHolderKind, position?.holder.id),
  });
  return {
    positionId,
    positionHasDeclaredSource: !!position?.fundingSource,
    positionInstrumentKind: position?.instrumentKind ?? 'unknown',
    positionHolderKind,
    positionHolderId: position?.holder.id ?? null,
    positionIsClosed: position?.status === 'closed',
    subType: subTypeForControl(control, row.subType, row.entryType),
    allocations: positionId === row.positionId ? row.allocations : [],
  };
}

function holderKindForPosition(
  position: ReturnType<LedgerIndex['positions']['get']>,
): EntryEditRow['positionHolderKind'] {
  if (position?.holder.kind === 'investor') return 'investor';
  if (position?.holder.kind === 'fund') return 'managed_fund';
  if (position?.holder.kind === 'external_fund') return 'unmanaged_fund';
  return 'unknown';
}

function cashHolderForEdit(
  kind: EntryEditRow['positionHolderKind'],
  holderId: string | null | undefined,
) {
  if (kind === 'managed_fund') {
    return { holder_fund_id: holderId ?? null, holderFundManaged: true };
  }
  if (kind === 'unmanaged_fund') {
    return { holder_fund_id: holderId ?? null, holderFundManaged: false };
  }
  if (kind === 'investor') return { holder_investor_id: holderId ?? null };
  return null;
}

function proceedsSubTypeOrDefault(subType: string): string {
  return toDivestmentSubType(subType) ?? SUB_TYPE_DIVESTMENT_CASH_IN_FUND;
}

/**
 * The sub-type a row must carry once its entry type or position changes.
 *
 * The control the row will show decides it: a managed-fund proceeds row keeps
 * its recorded destination (defaulting to cash in fund), a row that offers no
 * sub-type at all is cleared so nothing the user can no longer see is saved,
 * and every other row keeps its free text with any proceeds marker stripped.
 */
function subTypeForControl(
  control: 'destination' | 'free_text' | 'none',
  subType: string | null | undefined,
  entryType: FlEntryType | string,
): string {
  if (control === 'destination') return proceedsSubTypeOrDefault(subType ?? '');
  if (control === 'none') return '';
  return demoteProceedsTreatment(subType, entryType) ?? '';
}

/** Whether this edit row needs the retained/distributed proceeds choice. */
export function editRowHasProceedsTreatment(row: EntryEditRow): boolean {
  return isProceedsTreatmentApplicable({
    entryType: row.entryType,
    holder: cashHolderForEdit(row.positionHolderKind, row.positionHolderId),
  });
}

/**
 * The sub-type control this edit row must show — the same rule the new-entry
 * dialog applies, so a sale that offers no sub-type on creation offers none here.
 */
export function editRowSubTypeControl(
  row: EntryEditRow,
): 'destination' | 'free_text' | 'none' {
  return subTypeControlFor({
    entryType: row.entryType,
    holder: cashHolderForEdit(row.positionHolderKind, row.positionHolderId),
  });
}

/** Applies an entry-type change and supplies the managed-fund proceeds default. */
export function applyEntryTypeChange(
  row: EntryEditRow,
  entryType: FlEntryType,
): Partial<EntryEditRow> {
  const control = subTypeControlFor({
    entryType,
    holder: cashHolderForEdit(row.positionHolderKind, row.positionHolderId),
  });
  return {
    entryType,
    subType: subTypeForControl(control, row.subType, entryType),
  };
}

/**
 * True when the event cannot be edited at all.
 *
 * In-place edits are refused if the event is part of an older reversal pair:
 * mutating one side while its mirror still stands would silently double-count.
 * 1. Reversed events cannot be edited (they were reversed and are kept as
 *    history; to change the numbers, post a new event).
 * 2. Reversal events and reversal rows cannot be edited (they reverse another
 *    event and are kept as history; to change the numbers, post a new event).
 */
export function editBlockedReason(draft: EventEditDraft): string | null {
  if (draft.status === 'reversed') {
    return 'This event was reversed and is kept as history. To change the numbers, post a new event.';
  }
  if (draft.reversalOfEventId || draft.rows.some((row) => row.isReversal)) {
    return 'This row reverses another event and is kept as history. To change the numbers, post a new event.';
  }
  return null;
}

/** The whole event under edit. */
export interface EventEditDraft {
  eventId: string;
  /** Applies to every row: the service re-posts them all on the event date. */
  eventDate: string;
  description: string;
  status?: string;
  reversalOfEventId?: string | null;
  rows: EntryEditRow[];
}

/** True when this event's rows cannot be edited independently of each other. */
export function isTransferEvent(draft: EventEditDraft): boolean {
  return draft.rows.some((row) => !!row.counterpartyPositionId);
}

/**
 * A stored `numeric(38,8)` as the text of an editable field.
 *
 * The column serialises as "-43780000.00000000", six digits of which are noise
 * in a money field. Trailing zeros come off and the fraction is padded back to
 * `minScale`, so a commitment or a cash amount reads "-43,780,000.00" while a
 * unit count keeps whatever precision it was stored with. Digits that carry a
 * value are never dropped: a sub-cent amount stays visible rather than being
 * rounded away here and then written back rounded on the next save.
 */
export function editableDecimal(value: string | null | undefined, minScale = 2): string {
  if (value == null || String(value).trim() === '') return '';
  let full: string;
  try {
    full = toDecimalString(String(value));
  } catch {
    return String(value);
  }
  const [whole, fraction = ''] = full.split('.');
  const kept = fraction.replace(/0+$/, '').padEnd(minScale, '0');
  return kept ? `${whole}.${kept}` : whole;
}

/**
 * Seed a draft from the event and every entry it caused.
 *
 * `currency` pins every row to one code — the workspace display currency — so
 * an edit can't leave an event denominated in something the page never showed.
 * Omitted, each row keeps the currency it was stored with.
 */
export function eventEditDraftFrom(
  event: Tables<'fl_business_events'>,
  entries: FlPortfolioLedgerEntry[],
  index: LedgerIndex,
  currency?: string,
): EventEditDraft {
  return {
    eventId: event.id,
    eventDate: event.event_date,
    description: event.description ?? '',
    status: event.status,
    reversalOfEventId: event.reversal_of_event_id ?? null,
    rows: entries.map((entry) => {
      const position = index.positions.get(entry.position_id);
      const positionHolderKind = holderKindForPosition(position);
      const control = subTypeControlFor({
        entryType: entry.entry_type,
        holder: cashHolderForEdit(positionHolderKind, position?.holder.id),
      });
      return {
        id: entry.id,
        positionId: entry.position_id,
        entryType: entry.entry_type as FlEntryType,
        subType: subTypeForControl(control, entry.sub_type, entry.entry_type),
        // Money to two places; units and rates keep the precision they carry.
        commitmentDelta: editableDecimal(entry.commitment_delta ?? '0'),
        quantityDelta: editableDecimal(entry.quantity_delta ?? '0', 0),
        cashDelta: editableDecimal(entry.cash_delta ?? '0'),
        valuationDelta: editableDecimal(entry.valuation_delta ?? '0'),
        currency: currency ?? entry.currency,
        fxRate: editableDecimal(entry.fx_rate, 0),
        pricePerUnit: editableDecimal(entry.price_per_unit, 0),
        counterpartyPositionId: entry.counterparty_position_id ?? null,
        dataStatus: entry.data_status,
        notes: entry.notes ?? '',
        isReversal: entry.is_reversal === true,
        isDerivedCashLeg: isDerivedCashLegRow({
          entryType: entry.entry_type as FlEntryType,
          subType: entry.sub_type ?? '',
          counterpartyPositionId: entry.counterparty_position_id ?? null,
        }),
        sourceLedgerEntryId: entry.source_ledger_entry_id ?? null,
        positionHasDeclaredSource: !!position?.fundingSource,
        positionInstrumentKind: position?.instrumentKind ?? 'unknown',
        positionHolderKind,
        positionHolderId: position?.holder.id ?? null,
        positionIsClosed: position?.status === 'closed',
        allocations: (entry.allocations ?? []).map((allocation) => ({
          fundingSourceId: allocation.funding_source_id,
          amount: allocation.amount,
        })),
      };
    }),
  };
}

/** A user-typed decimal, normalised — or `null` when it isn't one yet. */
function decimalOrNull(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return toDecimalString(trimmed);
  } catch {
    return null;
  }
}

/** A delta field: blank counts as zero, anything unparseable is an error. */
function deltaOrError(input: string): string | null {
  if (!input.trim()) return toDecimalString('0');
  return decimalOrNull(input);
}

/**
 * Why the draft can't be saved, or `null` when it can.
 *
 * Checks the same rules `validateEntryDeltas` enforces, so a draft this accepts
 * is one the service accepts — the alternative is a 422 after the row has
 * already been deleted and re-posting has failed.
 */
export function eventEditProblem(draft: EventEditDraft): string | null {
  if (!draft.eventDate.trim()) return 'The event needs a date.';
  if (draft.rows.every((row) => row.isDerivedCashLeg)) {
    return 'An event needs at least one row.';
  }

  for (const row of draft.rows) {
    // Derived cash legs are neither sent nor editable, so validating them would
    // only block a save over figures the service is about to recompute.
    if (row.isDerivedCashLeg) continue;
    const spec = ENTRY_TYPES[row.entryType];
    if (!spec) return `Unknown entry type "${row.entryType}".`;
    if (!row.currency.trim()) return 'Every row needs a currency.';

    // The position is editable, so the pair (type, position) has to be checked
    // here — the service only reports the mismatch after it has deleted the
    // entries it is replacing.
    if (!row.positionId.trim()) return 'Every row needs a position.';
    if (row.positionIsClosed) {
      return 'That position is closed, so it cannot take an entry. Pick an open one.';
    }
    if (!allowsPositionKind(row.entryType, row.positionInstrumentKind)) {
      return `${entryTypeLabel(row.entryType)} can only sit on ${
        ENTRY_TYPES[row.entryType].on === 'fund' ? 'a fund' : 'an asset'
      } position.`;
    }

    const commitment = deltaOrError(row.commitmentDelta);
    const quantity = deltaOrError(row.quantityDelta);
    const cash = deltaOrError(row.cashDelta);
    if (commitment === null || quantity === null || cash === null) {
      return 'One of the deltas is not a number.';
    }
    if (row.fxRate.trim() && decimalOrNull(row.fxRate) === null) {
      return 'The FX rate is not a number.';
    }
    if (row.pricePerUnit.trim() && decimalOrNull(row.pricePerUnit) === null) {
      return 'The price per unit is not a number.';
    }

    const label = entryTypeLabel(row.entryType);
    if (!satisfiesRuleDecimal(spec.commitment, commitment)) {
      return `${label} cannot carry that commitment Δ.`;
    }
    if (!satisfiesRuleDecimal(spec.quantity, quantity)) {
      return `${label} cannot carry that quantity Δ.`;
    }
    if (!satisfiesRuleDecimal(spec.cash, cash)) {
      return `${label} cannot carry that cash Δ.`;
    }

    const valuation = deltaOrError(row.valuationDelta);
    if (valuation === null) return 'The valuation Δ is not a number.';
    // Only an adjustment may restate a carrying value; every other type is
    // required to leave it at zero.
    if (row.entryType !== 'adjustment' && !flIsZero(valuation)) {
      return `${label} cannot carry a valuation Δ — only an adjustment may.`;
    }

    if (editRowHasProceedsTreatment(row)) {
      const trimmed = row.subType.trim();
      if (!isDivestmentSubType(trimmed)) {
        return 'Choose a proceeds destination before saving.';
      }
    }
  }

  // A transfer moves value between two holders, so the event's own totals must
  // not budge. The service rejects legs that don't cancel; catch it here while
  // the numbers are still on screen.
  if (isTransferEvent(draft)) {
    const legs = draft.rows.filter((row) => row.counterpartyPositionId);
    for (const column of ['commitmentDelta', 'quantityDelta', 'cashDelta'] as const) {
      const total = legs.reduce((sum, row) => {
        const value = deltaOrError(row[column]);
        return sum + (value === null ? 0 : Number(value));
      }, 0);
      if (total !== 0) return 'The transfer legs no longer cancel to zero.';
    }
  }

  return null;
}

/** True when the draft would be accepted. */
export function isEventEditSavable(draft: EventEditDraft): boolean {
  return eventEditProblem(draft) === null;
}

/** True when nothing has been changed, so there is nothing to save. */
export function isEventEditUnchanged(
  draft: EventEditDraft,
  original: EventEditDraft,
): boolean {
  return JSON.stringify(draft) === JSON.stringify(original);
}

/**
 * The payload for `PATCH /api/fund-ledger/events/:id`.
 *
 * The route updates the event in place by replacing its entries, so any entry
 * not in this payload is deleted. A position that declares a source has its single
 * allocation recreated by the service and needs nothing here; an entry-level
 * split exists only on the entry being replaced, so it is sent back verbatim (and
 * its cash field is locked — see {@link cashIsLockedBySplit}).
 */
export function buildUpdateEventInput(draft: EventEditDraft): UpdateEventInput {
  const entries: LedgerEntryInput[] = draft.rows
    .filter((row) => !row.isDerivedCashLeg)
    .map((row) => ({
      position_id: row.positionId,
      // The route re-posts every row on the event date; there is no per-row date.
      entry_date: draft.eventDate,
      entry_type: row.entryType,
      sub_type: row.subType.trim() || null,
      commitment_delta: deltaOrError(row.commitmentDelta) ?? '0',
      quantity_delta: deltaOrError(row.quantityDelta) ?? '0',
      cash_delta: deltaOrError(row.cashDelta) ?? '0',
      valuation_delta: deltaOrError(row.valuationDelta) ?? '0',
      currency: row.currency.trim().toUpperCase(),
      fx_rate: decimalOrNull(row.fxRate),
      price_per_unit: decimalOrNull(row.pricePerUnit),
      counterparty_position_id: row.counterpartyPositionId,
      data_status: row.dataStatus,
      notes: row.notes.trim() || null,
      // Sent back only where the service could not derive it: a position that
      // declares a source gets its single default allocation recreated, but an
      // entry-level split exists nowhere else and would be lost on re-post.
      ...(cashIsLockedBySplit(row)
        ? {
            allocations: row.allocations.map((allocation) => ({
              funding_source_id: allocation.fundingSourceId,
              amount: allocation.amount,
            })),
          }
        : {}),
    }));

  return {
    event_date: draft.eventDate,
    description: draft.description.trim() || null,
    entries,
  };
}

/** True when a delta column is fixed at zero for this row's type. */
export function isDeltaLocked(
  entryType: FlEntryType,
  column: 'commitment' | 'quantity' | 'cash',
): boolean {
  return ENTRY_TYPES[entryType]?.[column] === 'zero';
}

/** True when a row's valuation Δ is fixed at zero for its type. */
export function valuationIsLocked(entryType: FlEntryType): boolean {
  return entryType !== 'adjustment';
}

/** A hint for a delta field, spelling out what its type allows. */
export function deltaHint(
  entryType: FlEntryType,
  column: 'commitment' | 'quantity' | 'cash',
): string {
  const rule = ENTRY_TYPES[entryType]?.[column];
  switch (rule) {
    case 'zero':
      return 'must be 0';
    case 'nonzero':
      return 'any non-zero';
    case 'positive':
      return 'must be above 0';
    case 'negative':
      return 'must be below 0';
    case 'non_negative':
      return '0 or above';
    case 'non_positive':
      return '0 or below';
    default:
      return 'any value';
  }
}

/** True when the price this row shows was derived rather than recorded. */
export function priceIsDerived(row: EntryEditRow): boolean {
  return (
    !row.pricePerUnit.trim() &&
    !flIsZero(deltaOrError(row.quantityDelta) ?? '0') &&
    !flIsZero(deltaOrError(row.cashDelta) ?? '0')
  );
}

/**
 * The row header label describing its role in the event.
 *
 * - Primary (non-derived) row: `{entryTypeLabel(row.entryType)} · {holder} → {instrument}`
 * - Derived cash leg: `Cash effect · {holder} · {instrument}`
 * - Transfer legs: append `· gives up` (negative delta) or `· receives` (positive delta)
 */
export function entryEditRowHeader(row: EntryEditRow, index: LedgerIndex): string {
  if (row.isDerivedCashLeg) {
    return `Cash effect · ${positionLabel(row.positionId, index)}`;
  }

  const label = entryTypeLabel(row.entryType);
  const target = positionDirectionLabel(row.positionId, index);

  if (
    row.entryType === 'commitment_transfer' ||
    row.entryType === 'unit_transfer' ||
    Boolean(row.counterpartyPositionId)
  ) {
    const commit = Number(row.commitmentDelta.replace(/,/g, '').trim());
    const qty = Number(row.quantityDelta.replace(/,/g, '').trim());
    if (commit < 0 || qty < 0) {
      return `${label} · ${target} · gives up`;
    }
    if (commit > 0 || qty > 0) {
      return `${label} · ${target} · receives`;
    }
  }

  return `${label} · ${target}`;
}

/** One row displayed in the editor, with its nesting status relative to its primary. */
export interface DisplayRowItem {
  row: EntryEditRow;
  isNested: boolean;
}

/**
 * Orders rows for display in EntryEditor:
 * 1. Primaries in their existing relative order
 * 2. Each primary immediately followed by any derived legs mirroring it (sourceLedgerEntryId === primary.id)
 * 3. Any orphaned derived legs (no matching primary in the draft) render last
 *
 * Does not mutate or reorder the underlying draft.rows array.
 */
export function orderRowsForDisplay(rows: EntryEditRow[]): DisplayRowItem[] {
  const primaries: { row: EntryEditRow; isNested: boolean }[] = [];
  const derivedByPrimaryId = new Map<string, EntryEditRow[]>();
  const orphanedDerived: EntryEditRow[] = [];

  for (const row of rows) {
    if (row.isDerivedCashLeg) {
      if (row.sourceLedgerEntryId) {
        const list = derivedByPrimaryId.get(row.sourceLedgerEntryId) ?? [];
        list.push(row);
        derivedByPrimaryId.set(row.sourceLedgerEntryId, list);
      } else {
        orphanedDerived.push(row);
      }
    } else {
      primaries.push({ row, isNested: false });
    }
  }

  const primaryIds = new Set(primaries.map((p) => p.row.id));
  const result: DisplayRowItem[] = [];

  for (const primary of primaries) {
    result.push(primary);
    const children = derivedByPrimaryId.get(primary.row.id);
    if (children) {
      for (const child of children) {
        result.push({ row: child, isNested: true });
      }
    }
  }

  for (const [sourceId, children] of derivedByPrimaryId.entries()) {
    if (!primaryIds.has(sourceId)) {
      orphanedDerived.push(...children);
    }
  }

  for (const orphan of orphanedDerived) {
    result.push({ row: orphan, isNested: false });
  }

  return result;
}
