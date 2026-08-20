import { describe, expect, it } from 'vitest';
import {
  commitmentEventKey,
  reviewCommitmentEventKey,
  fundUpdateTxnKey,
  fundUpdateValKey,
  sortFundUpdateReviewAssets,
  defaultCommitmentEventSelection,
  filterCommitmentEventsByInvestor,
  setInvestorCommitmentEventSelection,
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

describe('reviewCommitmentEventKey', () => {
  it('generates a deterministic key with normalized fund and investorName', () => {
    const ev1 = {
      fund: '  Fund Startech  ',
      investorName: '  Investor Alpha  ',
      date: '2024-01-15',
      intent: 'increase',
      amount: 1000000,
      sourceRow: 5,
    };
    const ev2 = {
      fund: 'fund startech',
      investorName: 'investor alpha',
      date: '2024-01-15',
      intent: 'increase',
      amount: 1000000,
      sourceRow: 5,
    };

    expect(reviewCommitmentEventKey(ev1)).toBe('fund startech|investor alpha|2024-01-15|increase|1000000|5');
    expect(reviewCommitmentEventKey(ev1)).toBe(reviewCommitmentEventKey(ev2));
  });

  it('differentiates distinct source rows', () => {
    const base = {
      fund: 'Fund A',
      investorName: 'Investor A',
      date: '2024-01-15',
      intent: 'increase',
      amount: 1000000,
    };
    const k1 = reviewCommitmentEventKey({ ...base, sourceRow: 3 });
    const k2 = reviewCommitmentEventKey({ ...base, sourceRow: 4 });
    expect(k1).not.toBe(k2);
  });

  it('differentiates distinct amounts, intents, dates, funds, and investors', () => {
    const base = {
      fund: 'Fund A',
      investorName: 'Investor A',
      date: '2024-01-15',
      intent: 'increase',
      amount: 1000000,
      sourceRow: 3,
    };
    expect(reviewCommitmentEventKey(base)).not.toBe(
      reviewCommitmentEventKey({ ...base, intent: 'decrease' }),
    );
    expect(reviewCommitmentEventKey(base)).not.toBe(
      reviewCommitmentEventKey({ ...base, amount: 2000000 }),
    );
    expect(reviewCommitmentEventKey(base)).not.toBe(
      reviewCommitmentEventKey({ ...base, date: '2024-02-15' }),
    );
    expect(reviewCommitmentEventKey(base)).not.toBe(
      reviewCommitmentEventKey({ ...base, fund: 'Fund B' }),
    );
    expect(reviewCommitmentEventKey(base)).not.toBe(
      reviewCommitmentEventKey({ ...base, investorName: 'Investor B' }),
    );
  });
});

describe('defaultCommitmentEventSelection', () => {
  it('selects only actionable events and excludes duplicate events', () => {
    const events = [
      { key: 'k1', status: 'actionable' as const },
      { key: 'k2', status: 'duplicate' as const },
      { key: 'k3', status: 'actionable' as const },
    ];
    const selected = defaultCommitmentEventSelection(events);
    expect(selected).toEqual(new Set(['k1', 'k3']));
    expect(selected.has('k2')).toBe(false);
  });

  it('returns empty set when given empty array or undefined', () => {
    expect(defaultCommitmentEventSelection([])).toEqual(new Set());
    expect(defaultCommitmentEventSelection(undefined)).toEqual(new Set());
  });
});

describe('filterCommitmentEventsByInvestor', () => {
  it('filters events matching the investor name case-insensitively with trimming', () => {
    const events = [
      { event: { investorName: 'Investor Alpha' }, id: 1 },
      { event: { investorName: 'investor alpha' }, id: 2 },
      { event: { investorName: 'Investor Beta' }, id: 3 },
    ];
    const filtered = filterCommitmentEventsByInvestor(events, '  INVESTOR ALPHA  ');
    expect(filtered).toHaveLength(2);
    expect(filtered.map((e) => e.id)).toEqual([1, 2]);
  });

  it('returns empty array when no events match', () => {
    const events = [{ event: { investorName: 'Investor Alpha' }, id: 1 }];
    expect(filterCommitmentEventsByInvestor(events, 'Nonexistent')).toEqual([]);
  });
});

describe('setInvestorCommitmentEventSelection', () => {
  const events = [
    { key: 'alpha-1', status: 'actionable' as const, event: { investorName: 'Alpha' } },
    { key: 'alpha-duplicate', status: 'duplicate' as const, event: { investorName: 'Alpha' } },
    { key: 'beta-1', status: 'actionable' as const, event: { investorName: 'Beta' } },
  ];

  it('selects every actionable event for the investor without selecting duplicates', () => {
    expect(setInvestorCommitmentEventSelection(new Set(['beta-1']), events, ' alpha ', true)).toEqual(
      new Set(['beta-1', 'alpha-1']),
    );
  });

  it('deselects only the investor events and preserves other investors', () => {
    expect(
      setInvestorCommitmentEventSelection(
        new Set(['alpha-1', 'alpha-duplicate', 'beta-1']),
        events,
        'ALPHA',
        false,
      ),
    ).toEqual(new Set(['beta-1']));
  });
});
