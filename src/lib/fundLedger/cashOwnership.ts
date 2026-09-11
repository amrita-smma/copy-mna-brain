export type CashHolderKind = 'fund';

export interface CashHolderCandidate {
  holder_investor_id?: string | null;
  holder_fund_id?: string | null;
  /** The stored `managed` flag of the holder fund. Never a client-supplied label. */
  holderFundManaged?: boolean | null;
}

import { IneligibleCashHolderError } from '@/lib/services/flErrors';
export { IneligibleCashHolderError };

/**
 * Returns true only when holder_fund_id is set AND holderFundManaged === true.
 * An investor holder is always false. An unmanaged fund is always false.
 * A candidate with neither is false.
 */
export function isEligibleCashHolder(
  candidate?: CashHolderCandidate | null,
): boolean {
  if (!candidate) {
    return false;
  }
  if (candidate.holder_investor_id && candidate.holder_investor_id.trim() !== '') {
    return false;
  }
  const fundId = candidate.holder_fund_id?.trim();
  return Boolean(fundId) && candidate.holderFundManaged === true;
}

/**
 * Throws IneligibleCashHolderError when the candidate is not an eligible cash holder.
 * The message names why: investor-held, unmanaged fund, or no holder.
 */
export function assertEligibleCashHolder(
  candidate: CashHolderCandidate | null | undefined,
  context: string = '',
): void {
  if (isEligibleCashHolder(candidate)) {
    return;
  }

  const prefix = context ? `${context}: ` : '';

  const investorId = candidate?.holder_investor_id?.trim();
  if (investorId) {
    throw new IneligibleCashHolderError(
      `${prefix}Ineligible cash holder: investor-held (${investorId})`,
    );
  }

  const fundId = candidate?.holder_fund_id?.trim();
  if (fundId && candidate?.holderFundManaged !== true) {
    throw new IneligibleCashHolderError(
      `${prefix}Ineligible cash holder: unmanaged fund (${fundId})`,
    );
  }

  throw new IneligibleCashHolderError(
    `${prefix}Ineligible cash holder: no holder`,
  );
}
