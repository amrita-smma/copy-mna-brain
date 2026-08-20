import { describe, expect, it } from 'vitest';
import {
  commitmentEventKey,
  fundUpdateTxnKey,
  fundUpdateValKey,
  sortFundUpdateReviewAssets,
  type FundUpdateAssetStatus,
} from './reviewKeys';

describe('commitmentEventKey', () => {
  it('generates matching keys for camelCase parsed event and snake_case DB record', () => {
    const parsedEvent = {
      date: '2023-05-20',
      event_type: 'initial_commitment',
      amount: 10_000_000,
    };
    const dbRecord = {
      effective_date: '2023-05-20',
      event_type: 'initial_commitment',
      amount: 10_000_000,
    };

    expect(commitmentEventKey(parsedEvent)).toBe('2023-05-20|initial_commitment|10000000');
    expect(commitmentEventKey(dbRecord)).toBe('2023-05-20|initial_commitment|10000000');
    expect(commitmentEventKey(parsedEvent)).toBe(commitmentEventKey(dbRecord));
  });

  it('prefers date over effective_date if both are present', () => {
    const event = {
      date: '2023-05-20',
      effective_date: '2023-01-01',
      event_type: 'additional_commitment',
      amount: 5_000_000,
    };
    expect(commitmentEventKey(event)).toBe('2023-05-20|additional_commitment|5000000');
  });

  it('handles null and undefined fields safely', () => {
    expect(commitmentEventKey({})).toBe('||');
    expect(
      commitmentEventKey({
        date: null,
        effective_date: null,
        event_type: null,
        amount: null,
      }),
    ).toBe('||');
  });

  it('handles 0 amount correctly', () => {
    expect(
      commitmentEventKey({
        date: '2023-06-01',
        event_type: 'reduction',
        amount: 0,
      }),
    ).toBe('2023-06-01|reduction|0');
  });

  it('differentiates distinct event types, amounts, and dates', () => {
    const key1 = commitmentEventKey({
      date: '2023-01-01',
      event_type: 'initial_commitment',
      amount: 1000,
    });
    const key2 = commitmentEventKey({
      date: '2023-01-01',
      event_type: 'additional_commitment',
      amount: 1000,
    });
    const key3 = commitmentEventKey({
      date: '2023-01-01',
      event_type: 'initial_commitment',
      amount: 2000,
    });
    const key4 = commitmentEventKey({
      date: '2023-01-02',
      event_type: 'initial_commitment',
      amount: 1000,
    });

    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
    expect(key1).not.toBe(key4);
  });
});

describe('fundUpdateTxnKey', () => {
  it('generates consistent keys across camelCase and snake_case properties', () => {
    const camel = {
      date: '2023-01-01',
      type: 'contribution',
      valueAmount: 1000,
      shareCount: 100,
      pricePerShare: 10,
    };
    const snake = {
      txn_date: '2023-01-01',
      txn_type: 'contribution',
      value_amount: 1000,
      share_count: 100,
      price_per_share: 10,
    };
    expect(fundUpdateTxnKey(camel)).toBe('2023-01-01|contribution|1000|100|10');
    expect(fundUpdateTxnKey(snake)).toBe('2023-01-01|contribution|1000|100|10');
  });
});

describe('fundUpdateValKey', () => {
  it('returns the asOfDate', () => {
    expect(fundUpdateValKey({ asOfDate: '2023-06-30' })).toBe('2023-06-30');
  });
});

describe('sortFundUpdateReviewAssets', () => {
  it('sorts by status (new -> add_missing -> unchanged) then by code', () => {
    const assets: Array<{ status: FundUpdateAssetStatus; code: string }> = [
      { status: 'unchanged', code: 'B' },
      { status: 'new', code: 'Z' },
      { status: 'add_missing', code: 'A' },
      { status: 'new', code: 'A' },
    ];
    const sorted = sortFundUpdateReviewAssets(assets);
    expect(sorted).toEqual([
      { status: 'new', code: 'A' },
      { status: 'new', code: 'Z' },
      { status: 'add_missing', code: 'A' },
      { status: 'unchanged', code: 'B' },
    ]);
  });
});
