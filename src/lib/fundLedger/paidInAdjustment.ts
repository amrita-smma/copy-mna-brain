/** Paid-in write-offs reuse valuation_delta as their signed amount, never as a valuation change. */
export const PAID_IN_WRITEOFF_SUBTYPE = 'paid_in_writeoff';

export function isPaidInAdjustment(entry: { entry_type: string; sub_type?: string | null }): boolean {
  return entry.entry_type === 'adjustment' && entry.sub_type === PAID_IN_WRITEOFF_SUBTYPE;
}

export function paidInAdjustmentDelta(entry: { entry_type: string; sub_type?: string | null; valuation_delta?: string | null }): string {
  return isPaidInAdjustment(entry) ? entry.valuation_delta ?? '0' : '0';
}
