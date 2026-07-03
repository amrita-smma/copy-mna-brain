/**
 * "Live process" status for a deal.
 *
 * By default a deal is considered live when it has an advisor engaged, but the
 * status can be explicitly overridden via `is_live`:
 *   - `is_live === true`  → forced live
 *   - `is_live === false` → forced not live
 *   - `is_live == null`   → derive from the presence of a (non-empty) advisor
 */
export interface DealLiveLike {
  is_live?: boolean | null;
  advisor?: string | null;
}

/** Effective live status, honouring the `is_live` override. */
export function isDealLive(company: DealLiveLike): boolean {
  if (company.is_live === true) return true;
  if (company.is_live === false) return false;
  return Boolean(company.advisor && company.advisor.trim());
}

/** Whether the live status was explicitly set (vs. derived from the advisor). */
export function isDealLiveOverridden(company: DealLiveLike): boolean {
  return company.is_live === true || company.is_live === false;
}
