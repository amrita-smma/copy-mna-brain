import { describe, expect, it } from 'vitest';
import {
  DESTINATION_TO_SUB_TYPE,
  DIVESTMENT_SUB_TYPES,
  SELL_PROCEEDS_DESTINATIONS,
  SELL_PROCEEDS_DESTINATION_VALUES,
  SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
  SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
  isDivestmentSubType,
  isSellProceedsDestination,
  toDivestmentSubType,
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

  it('exports canonical divestment subtype constants and list', () => {
    expect(SUB_TYPE_DIVESTMENT_CASH_IN_FUND).toBe('divestment:cash_in_fund');
    expect(SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR).toBe(
      'divestment:distributed_to_investor',
    );
    expect(DIVESTMENT_SUB_TYPES).toEqual([
      'divestment:cash_in_fund',
      'divestment:distributed_to_investor',
    ]);
    expect(DESTINATION_TO_SUB_TYPE).toEqual({
      cash_in_fund: 'divestment:cash_in_fund',
      distributed_to_investor: 'divestment:distributed_to_investor',
    });
  });

  it('validates canonical divestment subtypes with isDivestmentSubType guard', () => {
    expect(isDivestmentSubType(SUB_TYPE_DIVESTMENT_CASH_IN_FUND)).toBe(true);
    expect(isDivestmentSubType(SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR)).toBe(true);
    expect(isDivestmentSubType('cash_in_fund')).toBe(false);
    expect(isDivestmentSubType('distributed_to_investor')).toBe(false);
    expect(isDivestmentSubType('other')).toBe(false);
    expect(isDivestmentSubType('')).toBe(false);
    expect(isDivestmentSubType(null)).toBe(false);
    expect(isDivestmentSubType(undefined)).toBe(false);
    expect(isDivestmentSubType(123)).toBe(false);
    expect(isDivestmentSubType({})).toBe(false);
  });

  it('maps destination and subtype values via toDivestmentSubType helper', () => {
    // Sell proceeds destinations
    expect(toDivestmentSubType('cash_in_fund')).toBe(SUB_TYPE_DIVESTMENT_CASH_IN_FUND);
    expect(toDivestmentSubType('distributed_to_investor')).toBe(
      SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
    );

    // Canonical divestment subtypes (idempotent / passthrough)
    expect(toDivestmentSubType(SUB_TYPE_DIVESTMENT_CASH_IN_FUND)).toBe(
      SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
    );
    expect(toDivestmentSubType(SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR)).toBe(
      SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
    );

    // Fallbacks
    expect(toDivestmentSubType(null)).toBeNull();
    expect(toDivestmentSubType(undefined)).toBeNull();
    expect(toDivestmentSubType('')).toBeNull();
    expect(toDivestmentSubType('unknown')).toBeNull();
  });
});
