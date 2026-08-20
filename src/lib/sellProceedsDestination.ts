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
