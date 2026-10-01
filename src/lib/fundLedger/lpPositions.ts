/**
 * Which positions are a fund's LPs.
 *
 * An LP position of fund F is a position in F (`fund_id = F`, no asset) held by
 * an outside investor, or — when F is one of our managed funds — held by another
 * fund. A managed fund that invests in another managed fund holds the fund-held
 * position {holder_fund_id: holder, fund_id: F}; that one position is both the
 * holder's fund-of-funds holding (its `Fund.h`) and F's LP commitment. Counting
 * it on F's LP side never adds it to F's own holdings.
 *
 * Unmanaged (external) funds keep investor-held LPs only: a managed fund's
 * position in an external fund is our exposure to it, not its LP register.
 */
export interface LpPositionShape {
  fund_id?: string | null;
  asset_id?: string | null;
  holder_investor_id?: string | null;
  holder_fund_id?: string | null;
}

export interface LpFundShape {
  id: string;
  managed?: boolean | null;
}

export function isFundLpPosition(position: LpPositionShape, fund: LpFundShape): boolean {
  if (position.fund_id !== fund.id || position.asset_id) return false;
  if (position.holder_investor_id != null) return true;
  return (
    fund.managed === true &&
    position.holder_fund_id != null &&
    position.holder_fund_id !== fund.id
  );
}
