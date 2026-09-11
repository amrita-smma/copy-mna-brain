import {
  SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
  SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
} from '@/lib/sellProceedsDestination';
import {
  isProceedsTreatmentApplicable,
  subTypeControlFor,
  DEFAULT_PROCEEDS_TREATMENT,
  type CashHolderCandidate,
} from '@/lib/fundLedger/postDraft';

export interface DestinationOption {
  value: string;
  label: string;
}

export const PROCEEDS_DESTINATION_OPTIONS: readonly DestinationOption[] = [
  {
    value: SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
    label: 'Retained in fund',
  },
  {
    value: SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
    label: 'Distributed to investors',
  },
] as const;

/**
 * Resolves the destination value when entry type or holder changes:
 * - If applicable: preserves explicit valid destination, otherwise defaults to cash in fund.
 * - If not applicable: clears destination so stale state does not persist.
 */
export function resolveNextProceedsDestination(
  isApplicable: boolean,
  currentDestination?: string | null,
  fallback: string = SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
): string {
  if (!isApplicable) {
    return '';
  }
  if (
    currentDestination === SUB_TYPE_DIVESTMENT_CASH_IN_FUND ||
    currentDestination === SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR ||
    currentDestination === 'cash_in_fund' ||
    currentDestination === 'distributed_to_investor'
  ) {
    return currentDestination;
  }
  return fallback;
}

export {
  SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
  SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
  isProceedsTreatmentApplicable,
  subTypeControlFor,
  DEFAULT_PROCEEDS_TREATMENT,
  type CashHolderCandidate,
};

