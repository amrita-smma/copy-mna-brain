/**
 * The posting form's model: what the user has chosen so far, the rows it would
 * write, and the payload that goes to `POST /api/fund-ledger/events`.
 *
 * The form never asks for a sign. It asks "how much", and the entry type
 * decides — which is the same rule `FlLedgerService.validateEntryDeltas`
 * enforces, so a draft this module calls postable is one the service accepts.
 * The exceptions are a pledge being reduced, where the form offers an explicit
 * decrease toggle rather than guessing, and a paid-in write-off, which states
 * its direction outright (see `adjustmentDirectionOptions`).
 *
 * Magnitudes stay as the decimal strings the user typed and are signed with
 * BigInt arithmetic, so nothing is round-tripped through a double on its way to
 * the database.
 */

import type { LedgerEntryInput, PostEventInput } from '@/lib/api/fundLedger';
import {
  flAbs,
  flIsNegative,
  flIsPositive,
  flIsZero,
  flNeg,
  toDecimalString,
} from '@/lib/services/flDecimal';
import {
  ENTRY_TYPES,
  isTwoLegged,
  mirrorRuleForReversal,
  ruleAllowsEitherSign,
  type DeltaRule,
  type FlEntryType,
} from './entryTypes';
import {
  SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
  SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
  toDivestmentSubType,
} from '@/lib/sellProceedsDestination';
import {
  isProceedsTreatmentApplicable,
  subTypeControlFor,
  DEFAULT_PROCEEDS_TREATMENT,
} from './proceedsTreatment';
import type { CashHolderCandidate } from './cashOwnership';
import { resolveAdjustmentSubType } from './adjustmentSubTypes';
import { ADJUSTMENT_AMOUNT_LABELS } from './adjustmentSubTypes';
import type { InstrumentKind } from './derive';

/** An investor, fund or asset, addressed as `<kind>:<id>`. */
export type EntityKind = 'investor' | 'fund' | 'asset';

/** Build the key the form's comboboxes select by. */
export function entityKey(kind: EntityKind, id: string): string {
  return `${kind}:${id}`;
}

/** Split a key back into its kind and id, or `null` when it isn't one. */
export function parseEntityKey(key: string): { kind: EntityKind; id: string } | null {
  const separator = key.indexOf(':');
  if (separator <= 0) return null;
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  if (!id) return null;
  if (kind !== 'investor' && kind !== 'fund' && kind !== 'asset') return null;
  return { kind, id };
}

/** Everything the posting form has collected. */
export interface EntryDraft {
  type: FlEntryType;
  /** The `from` side of the movement, as an entity key. */
  from: string;
  /** The `to` side of the movement, as an entity key. */
  to: string;
  /** Transfers only: the fund the pledge or the units sit in. */
  instrument: string;
  /** Single-legged types: the position the row lands on. */
  positionId: string;
  /** Transfers: the position giving up, and the one receiving. */
  fromPositionId: string;
  toPositionId: string;
  date: string;
  /** Magnitude for the cash or commitment column, as typed. */
  amount: string;
  /** Magnitude for the quantity column, as typed. */
  units: string;
  /** Transfers only: what the receiver paid the giver. */
  consideration: string;
  /** Flip the sign on the columns whose rule allows either direction. */
  decrease: boolean;
  subType: string;
  notes: string;
  currency: string;
  /** Stored `managed` flag of the holder fund, when the holder is a fund. */
  holderFundManaged?: boolean | null;
  /**
   * What the selected position holds, supplied by the form. An adjustment's
   * sub-type is scoped by it: only a stake in a fund has paid-in capital to
   * write off.
   */
  instrumentKind?: InstrumentKind | null;
}

/** A blank draft, ready for the form. */
export function emptyDraft(date: string, currency = 'USD'): EntryDraft {
  return {
    type: 'buy',
    from: '',
    to: '',
    instrument: '',
    positionId: '',
    fromPositionId: '',
    toPositionId: '',
    date,
    amount: '',
    units: '',
    consideration: '',
    decrease: false,
    subType: '',
    notes: '',
    currency,
  };
}

/** One of the rows a draft would write. */
export interface DraftLeg {
  positionId: string;
  /** "Gives up" / "Receives" on a transfer; empty otherwise. */
  role: string;
  commitmentDelta: string;
  quantityDelta: string;
  cashDelta: string;
  valuationDelta: string;
  counterpartyPositionId: string | null;
}

/** Every delta leaves this module at the schema's scale, so shapes never vary. */
const ZERO = toDecimalString('0');

/** A magnitude the user typed, as an exact non-negative decimal string. */
function magnitude(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return ZERO;
  try {
    return flAbs(trimmed);
  } catch {
    // A half-typed "1." or a stray letter is not an error yet — the field is
    // still being filled in, so it reads as nothing rather than blocking.
    return ZERO;
  }
}

/** Apply a rule's sign convention to a magnitude, exactly. */
function signed(rule: DeltaRule, value: string, decrease: boolean): string {
  if (rule === 'zero') return ZERO;
  if (rule === 'negative' || rule === 'non_positive') return flNeg(value);
  if (rule === 'positive' || rule === 'non_negative') return value;
  return decrease ? flNeg(value) : value;
}

/** Whether an exact decimal satisfies a rule — the string counterpart of `satisfiesRule`. */
export function satisfiesRuleDecimal(
  rule: DeltaRule,
  value: string,
  isReversal = false,
): boolean {
  const effectiveRule = isReversal ? mirrorRuleForReversal(rule) : rule;
  switch (effectiveRule) {
    case 'zero':
      return flIsZero(value);
    case 'nonzero':
      return !flIsZero(value);
    case 'positive':
      return flIsPositive(value);
    case 'negative':
      return flIsNegative(value);
    case 'non_negative':
      return !flIsNegative(value);
    case 'non_positive':
      return !flIsPositive(value);
    case 'free':
      return true;
    default:
      return false;
  }
}

/**
 * Which column the single "amount" box feeds.
 *
 * Most types move cash, so it is the cash column. `commitment` never touches
 * cash but moves a pledge, so it spends the box there. An adjustment spends it
 * on the valuation column, as a paid-in write-off.
 */
/**
 * An adjustment posted from the ledger form spends its amount on
 * `valuation_delta`, never on commitment: `adjustmentSubTypesFor` decides
 * whether that delta reads as paid-in capital or as carrying value.
 *
 * The entry-type spec still says `commitment: 'free'`, deliberately: it governs
 * what an adjustment ALREADY on the books may hold, and tightening it would
 * lock existing commitment-carrying adjustments out of the edit form. This
 * narrows only what the posting form can create.
 */
export function postsAdjustmentDelta(type: FlEntryType): boolean {
  return type === 'adjustment';
}

export function amountTargetOf(type: FlEntryType): 'cash' | 'commitment' | 'valuation' | null {
  const spec = ENTRY_TYPES[type];
  if (!spec) return null;
  if (postsAdjustmentDelta(type)) return 'valuation';
  if (spec.cash !== 'zero') return 'cash';
  if (spec.commitment !== 'zero') return 'commitment';
  return null;
}

/** The label the amount box carries for a type. */
export function amountLabelOf(
  type: FlEntryType,
  subType?: string | null,
  instrumentKind?: InstrumentKind | null,
): string {
  const spec = ENTRY_TYPES[type];
  if (!spec) return 'Amount';
  if (spec.cash === 'negative' || spec.cash === 'non_positive') return 'Cash paid';
  if (spec.cash === 'positive' || spec.cash === 'non_negative') return 'Cash received';
  if (postsAdjustmentDelta(type)) {
    return ADJUSTMENT_AMOUNT_LABELS[resolveAdjustmentSubType(subType, instrumentKind)];
  }
  if (spec.cash === 'zero' && spec.commitment !== 'zero') return 'Amount pledged';
  return 'Amount';
}

/** True when the type can change the unit count, so the units box is live. */
export function needsUnits(type: FlEntryType): boolean {
  if (postsAdjustmentDelta(type)) return false;
  return ENTRY_TYPES[type]?.quantity !== 'zero';
}

/** True when the type moves an amount at all, so the amount box is live. */
export function needsAmount(type: FlEntryType): boolean {
  return amountTargetOf(type) !== null;
}

/** True when the form should offer a decrease toggle for this type. */
export function offersDecreaseToggle(type: FlEntryType): boolean {
  const spec = ENTRY_TYPES[type];
  if (!spec || isTwoLegged(type)) return false;
  // An adjustment states its direction through `adjustmentDirectionOptions`.
  if (postsAdjustmentDelta(type)) return false;
  return ruleAllowsEitherSign(spec.commitment) || ruleAllowsEitherSign(spec.quantity);
}

/**
 * The rows this draft would write — one, or two that cancel.
 *
 * A transfer's legs are mirror images naming each other as the counterparty,
 * which is exactly what `postEvent` checks before it will accept either.
 */
export function draftLegs(draft: EntryDraft): DraftLeg[] {
  const spec = ENTRY_TYPES[draft.type];
  if (!spec) return [];

  if (isTwoLegged(draft.type)) {
    const isCommitmentTransfer = draft.type === 'commitment_transfer';
    const moved = magnitude(isCommitmentTransfer ? draft.amount : draft.units);
    const cash = magnitude(draft.consideration);
    return [
      {
        positionId: draft.fromPositionId,
        role: 'Gives up',
        commitmentDelta: isCommitmentTransfer ? flNeg(moved) : ZERO,
        quantityDelta: isCommitmentTransfer ? ZERO : flNeg(moved),
        // The giver receives the consideration; the receiver pays it.
        cashDelta: cash,
        valuationDelta: ZERO,
        counterpartyPositionId: draft.toPositionId || null,
      },
      {
        positionId: draft.toPositionId,
        role: 'Receives',
        commitmentDelta: isCommitmentTransfer ? moved : ZERO,
        quantityDelta: isCommitmentTransfer ? ZERO : moved,
        cashDelta: flNeg(cash),
        valuationDelta: ZERO,
        counterpartyPositionId: draft.fromPositionId || null,
      },
    ];
  }

  const amount = magnitude(draft.amount);
  const units = magnitude(draft.units);
  const target = amountTargetOf(draft.type);

  return [
    {
      positionId: draft.positionId,
      role: '',
      commitmentDelta:
        target === 'commitment' ? signed(spec.commitment, amount, draft.decrease) : ZERO,
      quantityDelta: needsUnits(draft.type) ? signed(spec.quantity, units, draft.decrease) : ZERO,
      cashDelta: target === 'cash' ? signed(spec.cash, amount, draft.decrease) : ZERO,
      // A write-off's direction is stated, not derived from a delta rule.
      valuationDelta: target === 'valuation' ? (draft.decrease ? flNeg(amount) : amount) : ZERO,
      counterpartyPositionId: null,
    },
  ];
}

/** Why a draft can't be posted yet, or `null` when it can. */
export function draftProblem(draft: EntryDraft): string | null {
  const spec = ENTRY_TYPES[draft.type];
  if (!spec) return 'Pick an entry type.';

  const legs = draftLegs(draft);

  if (isTwoLegged(draft.type)) {
    if (!draft.fromPositionId || !draft.toPositionId) {
      return 'Pick a position on each side.';
    }
    if (draft.fromPositionId === draft.toPositionId) {
      return 'A transfer needs two different positions.';
    }
    const moved = magnitude(draft.type === 'commitment_transfer' ? draft.amount : draft.units);
    if (flIsZero(moved)) {
      return draft.type === 'commitment_transfer'
        ? 'Enter the commitment being transferred.'
        : 'Enter the number of units being transferred.';
    }
    return null;
  }

  if (!draft.positionId) return 'Pick a position before posting.';

  const leg = legs[0];
  if (!leg) return 'Nothing to post.';
  if (
    flIsZero(leg.commitmentDelta) &&
    flIsZero(leg.quantityDelta) &&
    flIsZero(leg.cashDelta) &&
    flIsZero(leg.valuationDelta)
  ) {
    return 'Enter an amount to post.';
  }
  if (!satisfiesRuleDecimal(spec.commitment, leg.commitmentDelta)) {
    return `${spec.label} cannot move commitment that way.`;
  }
  if (!satisfiesRuleDecimal(spec.quantity, leg.quantityDelta)) {
    return `${spec.label} cannot move units that way.`;
  }
  if (!satisfiesRuleDecimal(spec.cash, leg.cashDelta)) {
    return `${spec.label} cannot move cash that way.`;
  }

  const inward = spec.direction === 'in';
  const holderKey = inward ? draft.to : draft.from;
  const parsedHolder = parseEntityKey(holderKey);
  const candidate: CashHolderCandidate = {
    holder_investor_id: parsedHolder?.kind === 'investor' ? parsedHolder.id : null,
    holder_fund_id: parsedHolder?.kind === 'fund' ? parsedHolder.id : null,
    holderFundManaged: draft.holderFundManaged ?? null,
  };
  if (isProceedsTreatmentApplicable({ entryType: draft.type, holder: candidate })) {
    const trimmed = draft.subType.trim();
    if (
      trimmed !== SUB_TYPE_DIVESTMENT_CASH_IN_FUND &&
      trimmed !== SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR
    ) {
      return 'Choose a proceeds destination before posting.';
    }
  }

  return null;
}

export {
  isProceedsTreatmentApplicable,
  subTypeControlFor,
  DEFAULT_PROCEEDS_TREATMENT,
  type CashHolderCandidate,
};

/** True when the draft would be accepted. */
export function isDraftPostable(draft: EntryDraft): boolean {
  return draftProblem(draft) === null;
}

/**
 * The payload for `POST /api/fund-ledger/events`.
 *
 * Funding allocations are deliberately omitted: a position that declares a
 * source of fund gets exactly one allocation for the full amount, created by
 * the service, and one that declares none has nothing to attribute from this
 * form. Money from a different pool belongs on a different position.
 */
export function buildPostEventInput(draft: EntryDraft, description: string): PostEventInput {
  const legs = draftLegs(draft).filter((leg) => leg.positionId);
  const spec = ENTRY_TYPES[draft.type];
  const inward = spec?.direction === 'in';
  const holderKey = inward ? draft.to : draft.from;
  const parsedHolder = parseEntityKey(holderKey);
  const candidate: CashHolderCandidate = {
    holder_investor_id: parsedHolder?.kind === 'investor' ? parsedHolder.id : null,
    holder_fund_id: parsedHolder?.kind === 'fund' ? parsedHolder.id : null,
    holderFundManaged: draft.holderFundManaged ?? null,
  };
  const applicable = isProceedsTreatmentApplicable({ entryType: draft.type, holder: candidate });
  const rawSubType = draft.subType.trim() || null;
  const subType = applicable
    ? rawSubType
    : draft.type === 'sell' || toDivestmentSubType(rawSubType) !== null
      ? null
      : rawSubType;
  const notes = draft.notes.trim() || null;

  const entries: LedgerEntryInput[] = legs.map((leg) => ({
    position_id: leg.positionId,
    entry_date: draft.date,
    entry_type: draft.type,
    // An adjustment's sub-type is its meaning, not a label: it decides whether
    // `valuation_delta` counts towards paid-in capital or towards carrying
    // value. Resolved against the position rather than taken on trust, so a
    // draft left over from another position cannot post a paid-in write-off
    // against an asset.
    sub_type: postsAdjustmentDelta(draft.type)
      ? resolveAdjustmentSubType(draft.subType, draft.instrumentKind)
      : subType,
    commitment_delta: leg.commitmentDelta,
    quantity_delta: leg.quantityDelta,
    cash_delta: leg.cashDelta,
    valuation_delta: leg.valuationDelta,
    currency: draft.currency,
    counterparty_position_id: leg.counterpartyPositionId,
    notes,
  }));

  return {
    event_date: draft.date,
    description,
    entries,
  };
}
