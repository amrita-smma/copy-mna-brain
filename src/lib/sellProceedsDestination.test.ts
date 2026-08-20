import { describe, expect, it } from 'vitest';
import {
  SELL_PROCEEDS_DESTINATIONS,
  SELL_PROCEEDS_DESTINATION_VALUES,
  isSellProceedsDestination,
} from './sellProceedsDestination';

describe('sellProceedsDestination', () => {
  it('exports expected destination values', () => {
    expect(SELL_PROCEEDS_DESTINATIONS).toEqual([
      'cash_in_fund',
      'distributed_to_investor',
    ]);
    expect(SELL_PROCEEDS_DESTINATION_VALUES).toEqual(SELL_PROCEEDS_DESTINATIONS);
  });

  it('validates allowed sell proceeds destination strings with runtime guard', () => {
    expect(isSellProceedsDestination('cash_in_fund')).toBe(true);
    expect(isSellProceedsDestination('distributed_to_investor')).toBe(true);
    expect(isSellProceedsDestination('other')).toBe(false);
    expect(isSellProceedsDestination('invalid')).toBe(false);
    expect(isSellProceedsDestination('')).toBe(false);
    expect(isSellProceedsDestination(null)).toBe(false);
    expect(isSellProceedsDestination(undefined)).toBe(false);
    expect(isSellProceedsDestination(123)).toBe(false);
    expect(isSellProceedsDestination({})).toBe(false);
  });
});
