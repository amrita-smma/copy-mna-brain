/**
 * The adjustments a reviewer can post, as a closed set.
 *
 * `adjustment` is the only entry type allowed to carry a `valuation_delta`, and
 * the sub-type decides what that delta means: `paid_in_writeoff` folds into
 * paid-in capital (see `paidInAdjustmentDelta` and the `paid_in_adjustment_sum`
 * aggregate), while anything else is a carrying-value restatement. Leaving that
 * to free text meant a typo silently changed an entry's meaning, so the form
 * states it.
 *
 * Deliberately only these two: units and commitment have their own delta
 * columns, so a sub-type naming them would drive nothing. The edit form can
 * still reach those columns for corrections.
 */
import type { InstrumentKind } from './derive';
import { PAID_IN_WRITEOFF_SUBTYPE } from './paidInAdjustment';

export const VALUATION_RESTATEMENT_SUBTYPE = 'valuation_restatement';

export type AdjustmentSubType =
  | typeof PAID_IN_WRITEOFF_SUBTYPE
  | typeof VALUATION_RESTATEMENT_SUBTYPE;

export const ADJUSTMENT_SUB_TYPE_LABELS: Record<AdjustmentSubType, string> = {
  [PAID_IN_WRITEOFF_SUBTYPE]: 'Paid-in write-off',
  [VALUATION_RESTATEMENT_SUBTYPE]: 'Valuation restatement',
};

/** What the amount box is called, per kind of adjustment. */
export const ADJUSTMENT_AMOUNT_LABELS: Record<AdjustmentSubType, string> = {
  [PAID_IN_WRITEOFF_SUBTYPE]: 'Write-off amount',
  [VALUATION_RESTATEMENT_SUBTYPE]: 'Restatement amount',
};

/** What the adjustment actually moves, for the form's footnote. */
export const ADJUSTMENT_EFFECT_LABELS: Record<AdjustmentSubType, string> = {
  [PAID_IN_WRITEOFF_SUBTYPE]:
    'Adjusts paid-in capital only. No cash, commitment or units move.',
  [VALUATION_RESTATEMENT_SUBTYPE]:
    'Restates carrying value only. No cash, commitment or units move.',
};

/**
 * Which adjustments a position can take.
 *
 * A write-off needs paid-in capital, which only a stake in a fund has. On an
 * asset or cash position it would land in `contributed` and quietly restate that
 * holding's cost basis and MOIC, so it is not offered there — nor on a position
 * whose relations could not be resolved, where we cannot tell.
 *
 * With no position chosen yet (`null`), both are offered and the write-off leads:
 * it is what this form is mostly used for, and there is nothing to protect,
 * because a draft without a position cannot post at all. Narrowing happens when
 * a position actually says so, not before the reviewer has picked one.
 */
export function adjustmentSubTypesFor(
  instrumentKind: InstrumentKind | null | undefined,
): AdjustmentSubType[] {
  return instrumentKind === 'asset' || instrumentKind === 'unknown'
    ? [VALUATION_RESTATEMENT_SUBTYPE]
    : [PAID_IN_WRITEOFF_SUBTYPE, VALUATION_RESTATEMENT_SUBTYPE];
}

/**
 * The sub-type an adjustment will actually post with — the reviewer's choice
 * when the position allows it, and the first allowed option otherwise. Coerces
 * rather than rejects so switching position can never leave a draft that posts
 * a meaning the reviewer can no longer see.
 */
export function resolveAdjustmentSubType(
  subType: string | null | undefined,
  instrumentKind: InstrumentKind | null | undefined,
): AdjustmentSubType {
  const allowed = adjustmentSubTypesFor(instrumentKind);
  const trimmed = subType?.trim();
  return allowed.find((option) => option === trimmed) ?? allowed[0];
}

/** The direction wording for a kind of adjustment, signed by the same flag. */
export function adjustmentDirectionOptions(
  subType: AdjustmentSubType,
): readonly { value: 'increase' | 'decrease'; label: string }[] {
  return subType === PAID_IN_WRITEOFF_SUBTYPE
    ? [
        { value: 'increase', label: 'Increase paid-in capital' },
        { value: 'decrease', label: 'Decrease paid-in capital' },
      ]
    : [
        { value: 'increase', label: 'Increase carrying value' },
        { value: 'decrease', label: 'Decrease carrying value' },
      ];
}

export { PAID_IN_WRITEOFF_SUBTYPE };
