export const SELL_PROCEEDS_DESTINATIONS = [
  'cash_in_fund',
  'distributed_to_investor',
] as const;

export const SELL_PROCEEDS_DESTINATION_VALUES = SELL_PROCEEDS_DESTINATIONS;

export type SellProceedsDestination =
  (typeof SELL_PROCEEDS_DESTINATIONS)[number];

export function isSellProceedsDestination(
  value: unknown,
): value is SellProceedsDestination {
  return (
    typeof value === 'string' &&
    (SELL_PROCEEDS_DESTINATIONS as readonly string[]).includes(value)
  );
}

export const SUB_TYPE_DIVESTMENT_CASH_IN_FUND = 'divestment:cash_in_fund' as const;
export const SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR = 'divestment:distributed_to_investor' as const;

export const DIVESTMENT_SUB_TYPES = [
  SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
  SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
] as const;

export type DivestmentSubType = (typeof DIVESTMENT_SUB_TYPES)[number];

export function isDivestmentSubType(value: unknown): value is DivestmentSubType {
  return (
    typeof value === 'string' &&
    (DIVESTMENT_SUB_TYPES as readonly string[]).includes(value)
  );
}

export const DESTINATION_TO_SUB_TYPE: Record<SellProceedsDestination, DivestmentSubType> = {
  cash_in_fund: SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
  distributed_to_investor: SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
};

export function toDivestmentSubType(
  destination: SellProceedsDestination | string | null | undefined,
): DivestmentSubType | null {
  if (!destination) return null;
  if (destination === 'cash_in_fund' || destination === SUB_TYPE_DIVESTMENT_CASH_IN_FUND) {
    return SUB_TYPE_DIVESTMENT_CASH_IN_FUND;
  }
  if (
    destination === 'distributed_to_investor' ||
    destination === SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR
  ) {
    return SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR;
  }
  return null;
}

