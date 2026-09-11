import {
  SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
  toDivestmentSubType,
  type DivestmentSubType,
} from '@/lib/sellProceedsDestination';
import {
  isEligibleCashHolder,
  type CashHolderCandidate,
} from './cashOwnership';

export const PROCEEDS_TREATMENT_ENTRY_TYPES = [
  'sell',
  'distribution',
  'redemption',
] as const;

export type ProceedsTreatmentEntryType =
  (typeof PROCEEDS_TREATMENT_ENTRY_TYPES)[number];

export const DEFAULT_PROCEEDS_TREATMENT: DivestmentSubType =
  SUB_TYPE_DIVESTMENT_CASH_IN_FUND;

export interface ProceedsTreatmentApplicableParams {
  entryType?: string | null;
  holder?: CashHolderCandidate | null;
}

/**
 * Returns true when entryType is a proceeds-treatment entry type (sell, distribution, redemption)
 * and the holder is an eligible cash holder (managed fund).
 */
export function isProceedsTreatmentApplicable({
  entryType,
  holder,
}: ProceedsTreatmentApplicableParams = {}): boolean {
  if (!entryType) {
    return false;
  }
  const isProceedsEntry = (PROCEEDS_TREATMENT_ENTRY_TYPES as readonly string[]).includes(
    entryType,
  );
  return isProceedsEntry && isEligibleCashHolder(holder);
}

/**
 * Returns true for the bare "divestment" literal (or trimmed "divestment").
 * Used to detect unresolved divestment tokens from imports/review before defaulting.
 */
export function isUnresolvedDivestmentToken(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'divestment';
}

export interface ResolveProceedsTreatmentParams {
  entryType?: string | null;
  holder?: CashHolderCandidate | null;
  statedSubType?: string | null;
}

export interface ResolveProceedsTreatmentResult {
  subType: DivestmentSubType | null;
  defaulted: boolean;
}

/**
 * Resolves proceeds treatment for an entry:
 * - If not applicable (ineligible holder or non-proceeds entry), returns { subType: null, defaulted: false }.
 *   Any stated divestment treatment is dropped.
 * - If applicable and statedSubType maps to a real treatment via toDivestmentSubType, returns it with defaulted: false.
 * - If applicable and no usable treatment (null, undefined, empty, or unstated/bare "divestment"), returns
 *   DEFAULT_PROCEEDS_TREATMENT with defaulted: true.
 */
export function resolveProceedsTreatment({
  entryType,
  holder,
  statedSubType,
}: ResolveProceedsTreatmentParams = {}): ResolveProceedsTreatmentResult {
  if (!isProceedsTreatmentApplicable({ entryType, holder })) {
    return { subType: null, defaulted: false };
  }

  const trimmed = typeof statedSubType === 'string' ? statedSubType.trim() : statedSubType;
  const mapped = toDivestmentSubType(trimmed);
  if (mapped !== null) {
    return { subType: mapped, defaulted: false };
  }

  return { subType: DEFAULT_PROCEEDS_TREATMENT, defaulted: true };
}

/**
 * Demotes a proceeds treatment string back to its unspecialized base sub-type:
 * - strip a :cash_in_fund / :distributed_to_investor suffix, keep the base
 * - if the base is empty, return 'divestment'
 * - a bare cash_in_fund / distributed_to_investor becomes 'divestment'
 * - any other non-empty value passes through trimmed
 * - null/undefined/empty returns null
 *
 * It must never turn a value that carried a divestment marker into null.
 */
export function demoteProceedsTreatment(
  subType: string | null | undefined,
  entryType?: string | null,
): string | null {
  if (subType) {
    const trimmed = subType.trim();
    if (trimmed.endsWith(':cash_in_fund')) {
      const base = trimmed.slice(0, -':cash_in_fund'.length).trim();
      return base.length > 0 ? base : 'divestment';
    }
    if (trimmed.endsWith(':distributed_to_investor')) {
      const base = trimmed.slice(0, -':distributed_to_investor'.length).trim();
      return base.length > 0 ? base : 'divestment';
    }
    if (trimmed === 'cash_in_fund' || trimmed === 'distributed_to_investor') {
      return 'divestment';
    }
    return trimmed;
  }
  return null;
}


/**
 * Which sub-type control a form must offer for an entry — the one rule the
 * new-entry dialog and the edit form both read, so they cannot drift.
 *
 * - `destination` — the retained/distributed proceeds choice. A proceeds entry
 *   whose holder is an eligible cash holder (a managed fund).
 * - `none` — no sub-type at all. A sale whose holder cannot retain cash has no
 *   destination to state and no free-text sub-type to offer.
 * - `free_text` — the open sub-type field, for every other entry.
 */
export function subTypeControlFor({
  entryType,
  holder,
}: ProceedsTreatmentApplicableParams = {}): 'destination' | 'free_text' | 'none' {
  if (isProceedsTreatmentApplicable({ entryType, holder })) return 'destination';
  return entryType === 'sell' ? 'none' : 'free_text';
}
