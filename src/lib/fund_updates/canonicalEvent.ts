import { flAbs, flNeg, toExactDecimalString } from '@/lib/services/flDecimal';
import { FundUpdateValidationError } from '@/lib/services/flErrors';
import type { ReviewTransaction, ReviewBusinessEventEdits } from './types';

export type CanonicalEventKind =
  | 'buy'
  | 'sell'
  | 'distribution'
  | 'paid_in'
  | 'income'
  | 'expense'
  | 'other'
  | 'unknown';

export type CanonicalDirection = 'inflow' | 'outflow' | 'neutral';

export interface CanonicalEventClassification {
  canonicalKind: CanonicalEventKind;
  direction: CanonicalDirection;
  isEstimated: boolean;
  isUnresolved: boolean;
  unresolvedReason: string | null;
  isPostable: boolean;
  resolvedEntryType: 'paid_in' | 'buy' | 'sell' | 'redemption' | 'distribution' | 'income' | 'expense' | null;
  subType: string | null;
}

export type CanonicalClassification = CanonicalEventClassification;
export type FundUpdateCanonicalKind = CanonicalEventKind;

const OUTFLOW_ALIASES = new Set([
  'contribution',
  'buy',
  'investment',
  'asset_investment',
  'capital_call',
  'paid_in',
  'capital_contribution',
  'cost of investment',
]);

const DIVESTMENT_ALIASES = new Set([
  'divestment',
  'sell',
  'exit',
  'asset_exit',
  'redemption',
]);

const DISTRIBUTION_ALIASES = new Set([
  'distribution',
  'investor_distribution',
  'return_of_capital',
  'return of capital',
]);

const INCOME_ALIASES = new Set([
  'income',
  'interest',
  'interest_income',
  'interest income',
  'dividend',
]);

const EXPENSE_ALIASES = new Set([
  'expense',
  'expenses',
  'fee',
  'fees',
  'management_fee',
  'management fee',
]);

const ESTIMATED_REGEX = /\b(estimate|estimated|accrual|forecast|provisional|tentative)\b/i;
const CONTRADICTORY_REGEX = /\b(refund|reversal|rebate|clawback|offset)\b/i;
const NARROW_EXPENSE_REGEX = /\b(expenses?|fees?|management fees?|profit sharing fees?|audit fees?|legal fees?|taxes?|cit)\b/i;
const NARROW_INCOME_REGEX = /\b(dividends?|interest income|interest|gains?|income)\b/i;

export interface ClassifyFundUpdateTxnInput {
  type?: string | null;
  subTypeLabel?: string | null;
  notes?: string | null;
  valueAmount?: number | string | null;
  shareCount?: number | string | null;
  pricePerShare?: number | string | null;
  positionKind?: 'fund' | 'asset';
  /**
   * Set when a reviewer has explicitly reclassified an unresolved row into a concrete
   * economic type. This is the actual-event policy: estimate wording no longer short-circuits
   * classification, so the requested type is honoured. `isEstimated` still reports the source
   * wording so downstream consumers keep the provenance.
   */
  reviewerResolvedType?: boolean;
}

/**
 * Classifies a transaction row into a canonical economic event kind and cash direction.
 * Ensures consistent interpretation across review generation, user approval, and posting.
 */
export function classifyFundUpdateTxn(txn: ClassifyFundUpdateTxnInput): CanonicalEventClassification {
  const classification = classifyFundUpdateTxnCore(txn);
  if (!txn.reviewerResolvedType || classification.isEstimated) return classification;
  const descriptor = `${(txn.subTypeLabel ?? '').trim()} ${(txn.notes ?? '').trim()}`.trim();
  // Preserve the estimate provenance on a reviewer-resolved row: the wording is still an
  // estimate, but the reviewer has asserted it is an actual event, so it no longer blocks.
  return descriptor && ESTIMATED_REGEX.test(descriptor)
    ? { ...classification, isEstimated: true }
    : classification;
}

function classifyFundUpdateTxnCore(txn: ClassifyFundUpdateTxnInput): CanonicalEventClassification {
  const rawType = (txn.type ?? '').trim().toLowerCase();
  const notes = (txn.notes ?? '').trim();
  const subTypeLabel = (txn.subTypeLabel ?? '').trim();
  const descriptor = `${subTypeLabel} ${notes}`.trim();
  const positionKind = txn.positionKind ?? 'asset';

  const shareCountStr = txn.shareCount != null ? flAbs(toExactDecimalString(txn.shareCount)) : '0.00000000';
  const hasPositiveShares = txn.shareCount != null && Number(shareCountStr) > 0;

  // 1. Check for estimated / projected transactions. A reviewer who has explicitly
  // reclassified the row has supplied the actual-event policy, so the estimate wording
  // no longer short-circuits classification.
  if (descriptor && ESTIMATED_REGEX.test(descriptor) && !txn.reviewerResolvedType) {
    const isNegative =
      (typeof txn.valueAmount === 'number' && txn.valueAmount < 0) ||
      (typeof txn.valueAmount === 'string' && txn.valueAmount.trim().startsWith('-'));
    const isPositive =
      (typeof txn.valueAmount === 'number' && txn.valueAmount > 0) ||
      (typeof txn.valueAmount === 'string' && !txn.valueAmount.trim().startsWith('-') && Number(txn.valueAmount) > 0);
    return {
      canonicalKind: 'other',
      direction: isNegative ? 'outflow' : isPositive ? 'inflow' : 'neutral',
      isEstimated: true,
      isUnresolved: true,
      unresolvedReason: `Estimated transaction ("${descriptor}") is a projection/estimate and requires resolution before cash posting`,
      isPostable: false,
      resolvedEntryType: null,
      subType: subTypeLabel || notes || 'estimated',
    };
  }

  // 2. Recognized outflow (contribution / buy / paid_in)
  if (OUTFLOW_ALIASES.has(rawType)) {
    return {
      canonicalKind: positionKind === 'fund' ? 'paid_in' : 'buy',
      direction: 'outflow',
      isEstimated: false,
      isUnresolved: false,
      unresolvedReason: null,
      isPostable: true,
      resolvedEntryType: positionKind === 'fund' ? 'paid_in' : 'buy',
      subType: subTypeLabel || null,
    };
  }

  // 3. Recognized divestment / sale
  if (DIVESTMENT_ALIASES.has(rawType)) {
    const entryType =
      positionKind === 'fund'
        ? hasPositiveShares
          ? 'redemption'
          : 'distribution'
        : 'sell';
    return {
      canonicalKind: 'sell',
      direction: 'inflow',
      isEstimated: false,
      isUnresolved: false,
      unresolvedReason: null,
      isPostable: true,
      resolvedEntryType: entryType,
      subType: subTypeLabel || null,
    };
  }

  // 4. Recognized distribution / return of capital
  if (DISTRIBUTION_ALIASES.has(rawType)) {
    const entryType = positionKind === 'fund' ? 'distribution' : 'income';
    return {
      canonicalKind: 'distribution',
      direction: 'inflow',
      isEstimated: false,
      isUnresolved: false,
      unresolvedReason: null,
      isPostable: true,
      resolvedEntryType: entryType,
      subType: subTypeLabel || (rawType === 'distribution' ? null : rawType),
    };
  }

  // 5. Recognized income (interest, dividend)
  if (INCOME_ALIASES.has(rawType)) {
    const entryType = positionKind === 'fund' ? 'distribution' : 'income';
    return {
      canonicalKind: 'income',
      direction: 'inflow',
      isEstimated: false,
      isUnresolved: false,
      unresolvedReason: null,
      isPostable: true,
      resolvedEntryType: entryType,
      subType: subTypeLabel || (rawType === 'income' ? null : rawType),
    };
  }

  // 6. Recognized expense / fee
  if (EXPENSE_ALIASES.has(rawType)) {
    return {
      canonicalKind: 'expense',
      direction: 'outflow',
      isEstimated: false,
      isUnresolved: false,
      unresolvedReason: null,
      isPostable: true,
      resolvedEntryType: 'expense',
      subType: subTypeLabel || (rawType === 'expense' ? null : rawType),
    };
  }

  // 7. "Other" / "Others"
  if (rawType === 'other' || rawType === 'others') {
    const isNegative =
      (typeof txn.valueAmount === 'number' && txn.valueAmount < 0) ||
      (typeof txn.valueAmount === 'string' && txn.valueAmount.trim().startsWith('-'));
    const isPositive =
      (typeof txn.valueAmount === 'number' && txn.valueAmount > 0) ||
      (typeof txn.valueAmount === 'string' && !txn.valueAmount.trim().startsWith('-') && Number(txn.valueAmount) > 0);

    const hasContradictory = Boolean(descriptor && CONTRADICTORY_REGEX.test(descriptor));

    // Case A: Strictly negative with narrow established expense descriptor (and no contradictory words)
    if (isNegative && descriptor && !hasContradictory && NARROW_EXPENSE_REGEX.test(descriptor)) {
      return {
        canonicalKind: 'expense',
        direction: 'outflow',
        isEstimated: false,
        isUnresolved: false,
        unresolvedReason: null,
        isPostable: true,
        resolvedEntryType: 'expense',
        subType: subTypeLabel || notes || 'expense',
      };
    }

    // Case B: Strictly positive with narrow established income descriptor (and no contradictory words)
    if (isPositive && descriptor && !hasContradictory && NARROW_INCOME_REGEX.test(descriptor)) {
      const entryType = positionKind === 'fund' ? 'distribution' : 'income';
      return {
        canonicalKind: 'income',
        direction: 'inflow',
        isEstimated: false,
        isUnresolved: false,
        unresolvedReason: null,
        isPostable: true,
        resolvedEntryType: entryType,
        subType: subTypeLabel || notes || 'income',
      };
    }

    // Case C: Contradictory descriptors (e.g. positive with fee/refund, or negative with income/interest)
    if (
      descriptor &&
      (hasContradictory ||
        (isPositive && NARROW_EXPENSE_REGEX.test(descriptor)) ||
        (isNegative && NARROW_INCOME_REGEX.test(descriptor)))
    ) {
      return {
        canonicalKind: 'other',
        direction: isNegative ? 'outflow' : isPositive ? 'inflow' : 'neutral',
        isEstimated: false,
        isUnresolved: true,
        unresolvedReason: `Contradictory or uncertain descriptors on ${isNegative ? 'negative outflow' : 'positive receipt'} ("${descriptor}") require resolution before posting`,
        isPostable: false,
        resolvedEntryType: null,
        subType: subTypeLabel || notes || 'other',
      };
    }

    // Case D: Unexplained negative Other (e.g. BUMA row 26: Others, -30000 USD, no notes)
    if (isNegative) {
      return {
        canonicalKind: 'other',
        direction: 'outflow',
        isEstimated: false,
        isUnresolved: true,
        unresolvedReason: descriptor
          ? `Unresolved negative transaction ("${descriptor}") requires classification before posting`
          : 'Unexplained negative "Other" transaction requires classification before posting',
        isPostable: false,
        resolvedEntryType: null,
        subType: subTypeLabel || 'other',
      };
    }

    // Case E: Unexplained positive Other without descriptive label
    if (isPositive) {
      return {
        canonicalKind: 'other',
        direction: 'inflow',
        isEstimated: false,
        isUnresolved: true,
        unresolvedReason: descriptor
          ? `Unresolved positive transaction ("${descriptor}") requires classification before posting`
          : 'Unexplained positive "Other" transaction requires classification before posting',
        isPostable: false,
        resolvedEntryType: null,
        subType: subTypeLabel || 'other',
      };
    }

    // Zero-cash Other
    return {
      canonicalKind: 'other',
      direction: 'neutral',
      isEstimated: false,
      isUnresolved: true,
      unresolvedReason: 'Cannot post ambiguous zero-cash transaction for "other" type',
      isPostable: false,
      resolvedEntryType: null,
      subType: subTypeLabel || 'other',
    };
  }

  // 8. Unknown type: MUST NOT silently become Buy!
  return {
    canonicalKind: 'unknown',
    direction: 'neutral',
    isEstimated: false,
    isUnresolved: true,
    unresolvedReason: `Unknown transaction type "${rawType}" requires resolution before posting`,
    isPostable: false,
    resolvedEntryType: null,
    subType: subTypeLabel || rawType || null,
  };
}

/**
 * Computes the signed cash delta from the holder perspective:
 * - Outflow is negative
 * - Inflow is positive
 * - Preserves sign for unexplained Other
 */
export function computeSignedCashDelta(
  valueAmount: number | string | null | undefined,
  classification: CanonicalEventClassification,
): number | null {
  if (valueAmount == null) return null;
  const num = typeof valueAmount === 'number' ? valueAmount : Number(valueAmount);
  if (!Number.isFinite(num)) return null;

  if (classification.direction === 'outflow') {
    return -Math.abs(num);
  }
  if (classification.direction === 'inflow') {
    return Math.abs(num);
  }
  return num;
}

export const SUPPORTED_CLASSIFICATION_TYPES = new Set([
  'expense',
  'buy',
  'paid_in',
  'income',
  'sell',
  'distribution',
]);

/**
 * Reclassifies a review transaction by combining its canonical meaning with allow-listed reviewer edits.
 * Derives effective type, direction, signed cash, status, and resolution state consistently.
 *
 * Rules:
 * 1. Preserves original source evidence in rawTxn, subType, subTypeLabel, and notes.
 * 2. Projected / estimated rows are blocked on arrival and stay blocked while only amount/date/notes are edited.
 *    An explicit reviewer type resolution into a supported classification is the actual-event policy: it unblocks
 *    the row while `isEstimated` keeps reporting the source wording.
 * 3. Unexplained Other rows cannot be unblocked by changing only date/amount/notes.
 * 4. Explicit supported resolution (e.g. 'expense') reclassifies the row, derives direction and signed cash,
 *    and unblocks the row to actionable status (unless dependencies like missing holder block it).
 * 5. Incompatible classification directions (e.g. negative cash mapped to income, or positive cash mapped to expense)
 *    are explicitly rejected with FundUpdateValidationError rather than taking absolute values.
 * 6. Contradictory descriptors (positive fee-refund Other) remain unresolved without a refund policy.
 */
export function reclassifyReviewTransaction(
  txn: ReviewTransaction,
  edits?: ReviewBusinessEventEdits,
): ReviewTransaction {
  const result = { ...txn };

  // Apply allow-listed edits to standard fields
  if (edits) {
    if (edits.date !== undefined) result.date = edits.date;
    if (edits.amount !== undefined) result.amount = Number(edits.amount);
    if (edits.currency !== undefined) result.currency = edits.currency;
    if (edits.quantityDelta !== undefined) {
      result.quantityDelta = edits.quantityDelta === null ? null : Number(edits.quantityDelta);
    }
    if (edits.pricePerShare !== undefined) {
      result.pricePerShare = edits.pricePerShare === null ? null : Number(edits.pricePerShare);
    }
    if (edits.notes !== undefined) result.notes = edits.notes;
    if (edits.subTypeLabel !== undefined) result.subTypeLabel = edits.subTypeLabel;
    if (edits.cashDelta !== undefined) {
      result.cashDelta = edits.cashDelta === null ? null : Number(edits.cashDelta);
    }
    if (edits.transferorName !== undefined && result.singleTransferState) {
      result.singleTransferState = { ...result.singleTransferState, transferorName: edits.transferorName, enabled: true };
    }
    if (edits.allocations !== undefined && result.allocations) {
      result.allocations = edits.allocations.map((a, idx) => ({
        id: `alloc-${idx + 1}`,
        transferorName: a.transferorName,
        amount: a.amount,
      }));
    }
    if (edits.investorName !== undefined && result.nonCashState) {
      result.nonCashState = { ...result.nonCashState, investorName: edits.investorName, enabled: true };
    }
    if (edits.direction !== undefined && result.nonCashState) {
      result.nonCashState = { ...result.nonCashState, direction: edits.direction, enabled: true };
    }
    if (edits.subType !== undefined && result.nonCashState) {
      result.nonCashState = { ...result.nonCashState, subType: edits.subType, enabled: true };
    }
  }

  // 2. Commitment events, transfers, and non-cash adjustments follow dedicated pipelines
  const isCommitmentRow =
    result.backingRef?.kind === 'commitment_event' ||
    Boolean((result as any).rawCommitmentEvent) ||
    result.type === 'commitment' ||
    result.type === 'commitment_reduction' ||
    edits?.type === 'commitment' ||
    edits?.type === 'commitment_reduction';

  if (isCommitmentRow || result.isTransfer || result.isNonCashAdjustment) {
    if (edits) {
      if (edits.cashDelta !== undefined) {
        result.cashDelta = edits.cashDelta === null ? null : Number(edits.cashDelta);
      }
      if (edits.amount !== undefined) {
        result.amount = edits.amount === null ? null : Number(edits.amount);
      }
    }
    return result;
  }

  // 3. Authoritative cashDelta and amount derivation
  const isOutflow = (typeToCheck: string | null | undefined): boolean => {
    const t = (typeToCheck ?? '').trim().toLowerCase();
    return t === 'expense' || t === 'buy' || t === 'paid_in';
  };

  const hasCashDeltaEdit = edits?.cashDelta !== undefined;
  const hasAmountEdit = edits?.amount !== undefined;

  if (hasCashDeltaEdit && hasAmountEdit) {
    if (edits!.cashDelta !== null && edits!.amount !== null) {
      const deltaNum = Number(edits!.cashDelta);
      const amtNum = Number(edits!.amount);
      if (Math.abs(deltaNum) !== Math.abs(amtNum)) {
        throw new FundUpdateValidationError(
          `Contradictory cashDelta (${edits!.cashDelta}) and amount (${edits!.amount}) for transaction "${txn.id}"`,
        );
      }
      result.cashDelta = deltaNum;
      result.amount = Math.abs(deltaNum);
    } else if (edits!.cashDelta === null && edits!.amount !== null) {
      const numAmt = Math.abs(Number(edits!.amount));
      result.amount = numAmt;
      const targetType = edits?.type ?? result.type;
      result.cashDelta = isOutflow(targetType) ? -numAmt : numAmt;
    } else if (edits!.cashDelta === null && (edits!.amount === null || edits!.amount === undefined)) {
      throw new FundUpdateValidationError(
        `Cannot clear cashDelta for cash-bearing transaction "${txn.id}": missing required cash amount`,
      );
    } else {
      result.cashDelta = Number(edits!.cashDelta);
      result.amount = Math.abs(Number(edits!.cashDelta));
    }
  } else if (hasCashDeltaEdit) {
    if (edits!.cashDelta === null) {
      throw new FundUpdateValidationError(
        `Cannot clear cashDelta for cash-bearing transaction "${txn.id}": missing required cash amount`,
      );
    }
    result.cashDelta = Number(edits!.cashDelta);
    result.amount = Math.abs(Number(edits!.cashDelta));
  } else if (hasAmountEdit) {
    if (edits!.amount === null) {
      throw new FundUpdateValidationError(
        `Invalid amount for transaction "${txn.id}": amount cannot be null`,
      );
    }
    const numAmt = Math.abs(Number(edits!.amount));
    result.amount = numAmt;
    const targetType = edits?.type ?? result.type;
    result.cashDelta = isOutflow(targetType) ? -numAmt : numAmt;
  }

  // 4. Distinguish unresolved rows from ordinary canonical rows
  const rawType = (txn.rawTxn?.type ?? txn.type ?? '').trim().toLowerCase();
  const isClassificationBlockReason =
    txn.status === 'blocked' &&
    (!txn.blockReason ||
      /unexplained|classification|requires (resolution|classification) before.*posting|unknown.*type|contradictory/i.test(
        txn.blockReason,
      ));

  const isUnresolvedRow =
    txn.status === 'blocked' &&
    (rawType === 'other' ||
      rawType === 'others' ||
      rawType === 'unknown' ||
      txn.type === 'other' ||
      txn.type === 'unknown' ||
      isClassificationBlockReason);

  // If this is an ordinary canonical row (not unresolved), do NOT treat echoed edits.type as a classification change!
  if (!isUnresolvedRow) {
    return result;
  }

  // 5. Unresolved row handling
  const descriptor = `${result.subTypeLabel || ''} ${result.notes || ''} ${result.subType || ''}`.trim();
  const isEstimated =
    (descriptor && ESTIMATED_REGEX.test(descriptor)) ||
    Boolean(txn.blockReason && /estimate|projection/i.test(txn.blockReason)) ||
    Boolean(txn.rawTxn && classifyFundUpdateTxn(txn.rawTxn).isEstimated);

  const hasTypeResolution =
    edits?.type !== undefined &&
    SUPPORTED_CLASSIFICATION_TYPES.has(edits.type.trim().toLowerCase());

  if (isEstimated && !hasTypeResolution) {
    // No explicit reclassification: an estimate is not an actual cash event.
    result.status = 'blocked';
    result.isResolved = false;
    result.blockReason =
      txn.blockReason ||
      `Estimated transaction ("${descriptor}") is a projection/estimate and requires resolution before cash posting`;
    return result;
  }

  const signedCash =
    result.cashDelta != null
      ? result.cashDelta
      : result.rawTxn?.valueAmount != null
        ? Number(result.rawTxn.valueAmount)
        : null;

  const isNegative = signedCash != null && signedCash < 0;
  const isPositive = signedCash != null && signedCash > 0;

  const hasContradictory = Boolean(descriptor && CONTRADICTORY_REGEX.test(descriptor));
  if (hasContradictory && isPositive) {
    if (edits?.type && edits.type !== txn.type) {
      throw new FundUpdateValidationError(
        `Cannot classify positive fee-refund transaction "${txn.id}" without an explicit refund policy`,
      );
    }
    result.status = 'blocked';
    result.isResolved = false;
    result.blockReason =
      txn.blockReason ||
      `Contradictory or uncertain descriptors on positive receipt ("${descriptor}") require resolution before posting`;
    return result;
  }

  // Handle explicit type resolution edit
  if (edits?.type !== undefined) {
    const requestedType = edits.type.trim().toLowerCase();
    if (requestedType === 'other' || requestedType === 'others') {
      result.type = 'other';
      result.status = 'blocked';
      result.isResolved = false;
      result.blockReason = txn.blockReason || 'Unexplained "Other" transaction requires classification before posting';
      return result;
    }

    if (!SUPPORTED_CLASSIFICATION_TYPES.has(requestedType)) {
      throw new FundUpdateValidationError(
        `Unsupported classification type "${edits.type}" for transaction "${txn.id}"`,
      );
    }

    const isInflowType = requestedType === 'income' || requestedType === 'sell' || requestedType === 'distribution';
    const isOutflowType = requestedType === 'expense' || requestedType === 'buy' || requestedType === 'paid_in';

    if (isNegative && isInflowType) {
      throw new FundUpdateValidationError(
        `Cannot classify negative cash transaction as inflow type "${edits.type}"`,
      );
    }

    if (isPositive && isOutflowType) {
      throw new FundUpdateValidationError(
        `Cannot classify positive cash transaction as outflow type "${edits.type}"`,
      );
    }

    // Explicit resolution matches and is compatible
    result.type = requestedType;

    // If cashDelta was not explicitly provided in edits, align cashDelta sign with chosen direction
    if (!hasCashDeltaEdit && result.amount != null) {
      result.cashDelta = isOutflowType ? -Math.abs(result.amount) : Math.abs(result.amount);
    }

    // Check if there is an unrelated block reason
    const hasUnrelatedBlockReason =
      txn.blockReason &&
      !/unexplained|classification|requires (resolution|classification) before.*posting|unknown.*type|contradictory/i.test(txn.blockReason);

    if (hasUnrelatedBlockReason) {
      result.status = 'blocked';
      result.blockReason = txn.blockReason;
      result.isResolved = false;
    } else {
      result.status = 'actionable';
      result.blockReason = null;
      result.isResolved = true;
    }
    return result;
  }

  // No explicit type edit provided on blocked unresolved row -> remains blocked
  result.status = 'blocked';
  result.isResolved = false;
  result.blockReason = txn.blockReason || 'Unexplained "Other" transaction requires classification before posting';
  return result;
}

