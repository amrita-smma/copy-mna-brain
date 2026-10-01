import { describe, expect, it } from 'vitest';
import {
  commitmentEventKey,
  reviewCommitmentEventKey,
  fundUpdateTxnKey,
  fundUpdateValKey,
  normalizeTxnKeyType,
  buildCommitmentEventDedupKey,
  buildLedgerEntryCommitmentDedupKey,
  buildCommitmentTransferDedupKey,
  TransferInReplayGuard,
  buildAdjustmentDedupKey,
  sortFundUpdateReviewAssets,
  defaultCommitmentEventSelection,
  filterCommitmentEventsByInvestor,
  setInvestorCommitmentEventSelection,
  LEDGER_DECIMAL_SCALE,
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

  it('normalizes persisted high-precision decimal strings without floating-point rounding', () => {
    const parsed = {
      date: '2026-01-15', type: 'contribution',
      valueAmount: '9007199254740993.1234567800',
      shareCount: '0.00000000', pricePerShare: '1.25000000',
    };
    const persisted = {
      txn_date: '2026-01-15', txn_type: 'contribution',
      value_amount: '9007199254740993.12345678',
      share_count: null, price_per_share: '1.25',
    };
    expect(fundUpdateTxnKey(parsed)).toBe(fundUpdateTxnKey(persisted));
  });

  it('regression: matches proposed txn with float pricePerShare 19.1518951536866 against stored entry with price_per_unit 19.15189515', () => {
    const proposed = {
      date: '2021-09-29',
      type: 'contribution',
      valueAmount: 3225811.156,
      shareCount: 168433,
      pricePerShare: 19.1518951536866,
    };
    const stored = {
      txn_date: '2021-09-29',
      txn_type: 'contribution',
      value_amount: '3225811.156',
      share_count: '168433',
      price_per_share: '19.15189515',
    };
    expect(fundUpdateTxnKey(proposed)).toBe('2021-09-29|contribution|3225811.156|168433|19.15189515');
    expect(fundUpdateTxnKey(stored)).toBe('2021-09-29|contribution|3225811.156|168433|19.15189515');
    expect(fundUpdateTxnKey(proposed)).toBe(fundUpdateTxnKey(stored));
  });

  it('quantizes shareCount / quantity_delta beyond 8 decimals', () => {
    const proposed = {
      date: '2022-03-15',
      type: 'contribution',
      valueAmount: 1000,
      shareCount: 1234.123456784,
      pricePerShare: 10,
    };
    const stored = {
      txn_date: '2022-03-15',
      txn_type: 'contribution',
      value_amount: 1000,
      share_count: '1234.12345678',
      price_per_share: 10,
    };
    expect(fundUpdateTxnKey(proposed)).toBe('2022-03-15|contribution|1000|1234.12345678|10');
    expect(fundUpdateTxnKey(proposed)).toBe(fundUpdateTxnKey(stored));

    const proposedRoundUp = {
      date: '2022-03-15',
      type: 'contribution',
      valueAmount: 1000,
      shareCount: '1234.123456786',
      pricePerShare: 10,
    };
    const storedRoundUp = {
      txn_date: '2022-03-15',
      txn_type: 'contribution',
      value_amount: 1000,
      share_count: '1234.12345679',
      price_per_share: 10,
    };
    expect(fundUpdateTxnKey(proposedRoundUp)).toBe('2022-03-15|contribution|1000|1234.12345679|10');
    expect(fundUpdateTxnKey(proposedRoundUp)).toBe(fundUpdateTxnKey(storedRoundUp));
  });

  it('quantizes valueAmount / cash_delta beyond 8 decimals', () => {
    const proposed = {
      date: '2022-03-15',
      type: 'distribution',
      valueAmount: 54321.987654321,
      shareCount: 100,
      pricePerShare: 10,
    };
    const stored = {
      txn_date: '2022-03-15',
      txn_type: 'distribution',
      value_amount: '54321.98765432',
      share_count: 100,
      price_per_share: 10,
    };
    expect(fundUpdateTxnKey(proposed)).toBe('2022-03-15|distribution|54321.98765432|100|10');
    expect(fundUpdateTxnKey(proposed)).toBe(fundUpdateTxnKey(stored));

    const proposedRoundUp = {
      date: '2022-03-15',
      type: 'distribution',
      valueAmount: '54321.987654325',
      shareCount: 100,
      pricePerShare: 10,
    };
    const storedRoundUp = {
      txn_date: '2022-03-15',
      txn_type: 'distribution',
      value_amount: '54321.98765433',
      share_count: 100,
      price_per_share: 10,
    };
    expect(fundUpdateTxnKey(proposedRoundUp)).toBe('2022-03-15|distribution|54321.98765433|100|10');
    expect(fundUpdateTxnKey(proposedRoundUp)).toBe(fundUpdateTxnKey(storedRoundUp));
  });

  it('performs half-up rounding away from zero at the scale 8 boundary for positive and negative values', () => {
    // Positive boundary: 0.000000005 -> 0.00000001; 0.0000000049 -> 0
    expect(fundUpdateTxnKey({ date: '2023-01-01', type: 't', pricePerShare: '0.000000005' }))
      .toBe('2023-01-01|t|||0.00000001');
    expect(fundUpdateTxnKey({ date: '2023-01-01', type: 't', pricePerShare: '0.0000000049' }))
      .toBe('2023-01-01|t|||0');
    expect(fundUpdateTxnKey({ date: '2023-01-01', type: 't', pricePerShare: '1.000000005' }))
      .toBe('2023-01-01|t|||1.00000001');
    expect(fundUpdateTxnKey({ date: '2023-01-01', type: 't', pricePerShare: '1.0000000049' }))
      .toBe('2023-01-01|t|||1');

    // Negative boundary: -0.000000005 -> -0.00000001; -0.0000000049 -> 0
    expect(fundUpdateTxnKey({ date: '2023-01-01', type: 't', pricePerShare: '-0.000000005' }))
      .toBe('2023-01-01|t|||-0.00000001');
    expect(fundUpdateTxnKey({ date: '2023-01-01', type: 't', pricePerShare: '-0.0000000049' }))
      .toBe('2023-01-01|t|||0');
    expect(fundUpdateTxnKey({ date: '2023-01-01', type: 't', pricePerShare: '-1.000000005' }))
      .toBe('2023-01-01|t|||-1.00000001');
    expect(fundUpdateTxnKey({ date: '2023-01-01', type: 't', pricePerShare: '-1.0000000049' }))
      .toBe('2023-01-01|t|||-1');
  });

  it('leaves values with 8 or fewer decimal places unchanged without false merging', () => {
    const key1 = fundUpdateTxnKey({ date: '2023-01-01', type: 't', pricePerShare: '1.12345678' });
    const key2 = fundUpdateTxnKey({ date: '2023-01-01', type: 't', pricePerShare: '1.12345679' });
    expect(key1).toBe('2023-01-01|t|||1.12345678');
    expect(key2).toBe('2023-01-01|t|||1.12345679');
    expect(key1).not.toBe(key2);

    const key3 = fundUpdateTxnKey({ date: '2023-01-01', type: 't', pricePerShare: '0.1' });
    const key4 = fundUpdateTxnKey({ date: '2023-01-01', type: 't', pricePerShare: '0.2' });
    expect(key3).not.toBe(key4);

    const keyA = fundUpdateTxnKey({ date: '2023-01-01', type: 't', pricePerShare: '2.5' });
    const keyB = fundUpdateTxnKey({ date: '2023-01-01', type: 't', pricePerShare: '2.50000000' });
    expect(keyA).toBe('2023-01-01|t|||2.5');
    expect(keyA).toBe(keyB);
  });

  it('produces identical keys for two transactions differing only beyond the 8th decimal place', () => {
    // Indistinguishable once stored in numeric(38, 8), so treating them as one is correct
    const txA = {
      date: '2023-01-01',
      type: 'contribution',
      pricePerShare: '10.123456781',
    };
    const txB = {
      date: '2023-01-01',
      type: 'contribution',
      pricePerShare: '10.123456784',
    };
    expect(fundUpdateTxnKey(txA)).toBe('2023-01-01|contribution|||10.12345678');
    expect(fundUpdateTxnKey(txB)).toBe('2023-01-01|contribution|||10.12345678');
    expect(fundUpdateTxnKey(txA)).toBe(fundUpdateTxnKey(txB));

    const txC = {
      date: '2023-01-01',
      type: 'contribution',
      pricePerShare: '10.123456786',
    };
    const txD = {
      date: '2023-01-01',
      type: 'contribution',
      pricePerShare: '10.123456789',
    };
    expect(fundUpdateTxnKey(txC)).toBe('2023-01-01|contribution|||10.12345679');
    expect(fundUpdateTxnKey(txD)).toBe('2023-01-01|contribution|||10.12345679');
    expect(fundUpdateTxnKey(txC)).toBe(fundUpdateTxnKey(txD));
  });

  it('preserves key-format where a transaction with no quantity and no price yields date|type|value||', () => {
    const txnWithoutQtyPrice = {
      date: '2023-01-01',
      type: 'contribution',
      valueAmount: 1000,
    };
    expect(fundUpdateTxnKey(txnWithoutQtyPrice)).toBe('2023-01-01|contribution|1000||');

    const txnWithExplicitNulls = {
      date: '2023-01-01',
      type: 'contribution',
      valueAmount: '1000.00000000',
      shareCount: null,
      pricePerShare: null,
    };
    expect(fundUpdateTxnKey(txnWithExplicitNulls)).toBe('2023-01-01|contribution|1000||');

    // Quantity 0 means untracked, treated as empty
    const txnWithZeroQuantity = {
      txn_date: '2023-01-01',
      txn_type: 'contribution',
      value_amount: 1000,
      share_count: '0.00000000',
      price_per_share: null,
    };
    expect(fundUpdateTxnKey(txnWithZeroQuantity)).toBe('2023-01-01|contribution|1000||');
  });

  it('passes through non-numeric values without modification', () => {
    expect(
      fundUpdateTxnKey({
        date: '2023-01-01',
        type: 'contribution',
        valueAmount: 'untracked',
        shareCount: 'N/A',
        pricePerShare: 'TBD',
      }),
    ).toBe('2023-01-01|contribution|untracked|N/A|TBD');
  });

  it('exports LEDGER_DECIMAL_SCALE matching numeric(38, 8)', () => {
    expect(LEDGER_DECIMAL_SCALE).toBe(8);
  });

  describe('normalizeTxnKeyType', () => {
    it('normalizes other and others case-insensitively to other', () => {
      expect(normalizeTxnKeyType('other')).toBe('other');
      expect(normalizeTxnKeyType('others')).toBe('other');
      expect(normalizeTxnKeyType('Others')).toBe('other');
      expect(normalizeTxnKeyType('Other')).toBe('other');
      expect(normalizeTxnKeyType('OTHERS')).toBe('other');
      expect(normalizeTxnKeyType('  Others  ')).toBe('other');
    });

    it('preserves distinct named categories without collapsing', () => {
      expect(normalizeTxnKeyType('contribution')).toBe('contribution');
      expect(normalizeTxnKeyType('divestment')).toBe('divestment');
      expect(normalizeTxnKeyType('dividend')).toBe('dividend');
      expect(normalizeTxnKeyType('return_of_capital')).toBe('return_of_capital');
      expect(normalizeTxnKeyType('interest_income')).toBe('interest_income');
      expect(normalizeTxnKeyType('management_fee')).toBe('management_fee');
    });
  });

  it('normalizes generic other and Others across proposal and persisted keys', () => {
    const proposal = { date: '2022-09-13', type: 'other', valueAmount: 1922.42 };
    const persisted = { txn_date: '2022-09-13', txn_type: 'Others', value_amount: '1922.42' };
    expect(fundUpdateTxnKey(proposal)).toBe('2022-09-13|other|1922.42||');
    expect(fundUpdateTxnKey(persisted)).toBe('2022-09-13|other|1922.42||');
    expect(fundUpdateTxnKey(proposal)).toBe(fundUpdateTxnKey(persisted));
  });

  it('normalizes signed values to absolute cash amounts so negative proposal amounts match positive replay amounts', () => {
    const proposalMega = {
      date: '2025-04-22',
      type: 'divestment',
      valueAmount: -3436548.21,
    };
    const persistedMega = {
      txn_date: '2025-04-22',
      txn_type: 'divestment',
      value_amount: '3436548.21000000',
    };
    expect(fundUpdateTxnKey(proposalMega)).toBe('2025-04-22|divestment|3436548.21||');
    expect(fundUpdateTxnKey(persistedMega)).toBe('2025-04-22|divestment|3436548.21||');
    expect(fundUpdateTxnKey(proposalMega)).toBe(fundUpdateTxnKey(persistedMega));

    const proposalSstu = {
      date: '2022-09-13',
      type: 'other',
      valueAmount: -1922.41675248884,
    };
    const persistedSstu = {
      txn_date: '2022-09-13',
      txn_type: 'Others',
      value_amount: '-1922.41675249',
    };
    expect(fundUpdateTxnKey(proposalSstu)).toBe('2022-09-13|other|-1922.41675249||');
    expect(fundUpdateTxnKey(persistedSstu)).toBe('2022-09-13|other|-1922.41675249||');
    expect(fundUpdateTxnKey(proposalSstu)).toBe(fundUpdateTxnKey(persistedSstu));

    const proposalXtal28 = {
      date: '2025-08-21',
      type: 'other',
      valueAmount: -2400000,
    };
    const persistedXtal28 = {
      txn_date: '2025-08-21',
      txn_type: 'Others',
      value_amount: '-2400000',
    };
    expect(fundUpdateTxnKey(proposalXtal28)).toBe('2025-08-21|other|-2400000||');
    expect(fundUpdateTxnKey(persistedXtal28)).toBe('2025-08-21|other|-2400000||');
    expect(fundUpdateTxnKey(proposalXtal28)).toBe(fundUpdateTxnKey(persistedXtal28));

    const proposalXtal29 = {
      date: '2025-08-21',
      type: 'other',
      valueAmount: -1034612.6859154929,
    };
    const persistedXtal29 = {
      txn_date: '2025-08-21',
      txn_type: 'Others',
      value_amount: '-1034612.68591549',
    };
    expect(fundUpdateTxnKey(proposalXtal29)).toBe('2025-08-21|other|-1034612.68591549||');
    expect(fundUpdateTxnKey(persistedXtal29)).toBe('2025-08-21|other|-1034612.68591549||');
    expect(fundUpdateTxnKey(proposalXtal29)).toBe(fundUpdateTxnKey(persistedXtal29));
  });

  it('normalizes negative share count to unsigned magnitude for sell/divestment replay matching', () => {
    const proposal = {
      date: '2023-01-15',
      type: 'divestment',
      valueAmount: 50000,
      shareCount: -5000,
      pricePerShare: 10,
    };
    const persisted = {
      txn_date: '2023-01-15',
      txn_type: 'divestment',
      value_amount: '50000',
      share_count: '5000',
      price_per_share: '10',
    };
    expect(fundUpdateTxnKey(proposal)).toBe('2023-01-15|divestment|50000|5000|10');
    expect(fundUpdateTxnKey(persisted)).toBe('2023-01-15|divestment|50000|5000|10');
    expect(fundUpdateTxnKey(proposal)).toBe(fundUpdateTxnKey(persisted));
  });

  describe('negative tests: genuinely different transactions do not dedup', () => {
    const base = {
      date: '2022-09-13',
      type: 'other',
      valueAmount: 1922.41675249,
      shareCount: null,
      pricePerShare: null,
    };

    it('differentiates by date', () => {
      const differentDate = { ...base, date: '2022-09-14' };
      expect(fundUpdateTxnKey(base)).not.toBe(fundUpdateTxnKey(differentDate));
    });

    it('differentiates by semantic type without collapsing named categories', () => {
      const dividend = { ...base, type: 'dividend' };
      const managementFee = { ...base, type: 'management_fee' };
      const returnOfCapital = { ...base, type: 'return_of_capital' };
      const interestIncome = { ...base, type: 'interest_income' };
      const contribution = { ...base, type: 'contribution' };
      const divestment = { ...base, type: 'divestment' };

      expect(fundUpdateTxnKey(base)).not.toBe(fundUpdateTxnKey(dividend));
      expect(fundUpdateTxnKey(base)).not.toBe(fundUpdateTxnKey(managementFee));
      expect(fundUpdateTxnKey(dividend)).not.toBe(fundUpdateTxnKey(returnOfCapital));
      expect(fundUpdateTxnKey(dividend)).not.toBe(fundUpdateTxnKey(interestIncome));
      expect(fundUpdateTxnKey(contribution)).not.toBe(fundUpdateTxnKey(divestment));
    });

    it('differentiates by value amount within 8-decimal scale', () => {
      const differentValue = { ...base, valueAmount: 1922.41675248 };
      expect(fundUpdateTxnKey(base)).not.toBe(fundUpdateTxnKey(differentValue));
    });

    it('differentiates by share count', () => {
      const withShares = { ...base, shareCount: 100 };
      const differentShares = { ...base, shareCount: 200 };
      expect(fundUpdateTxnKey(base)).not.toBe(fundUpdateTxnKey(withShares));
      expect(fundUpdateTxnKey(withShares)).not.toBe(fundUpdateTxnKey(differentShares));
    });

    it('differentiates by price per share', () => {
      const withPps = { ...base, pricePerShare: 10 };
      const differentPps = { ...base, pricePerShare: 11 };
      expect(fundUpdateTxnKey(base)).not.toBe(fundUpdateTxnKey(withPps));
      expect(fundUpdateTxnKey(withPps)).not.toBe(fundUpdateTxnKey(differentPps));
    });
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

describe('buildCommitmentEventDedupKey', () => {
  it('builds positive exact decimal keys for commitment increase', () => {
    expect(buildCommitmentEventDedupKey('increase', '2023-05-20', 10000000)).toBe(
      'commitment|2023-05-20|10000000.00000000',
    );
  });

  it('builds negative exact decimal keys for commitment decrease', () => {
    expect(buildCommitmentEventDedupKey('decrease', '2023-05-20', 5000000)).toBe(
      'commitment|2023-05-20|-5000000.00000000',
    );
    // Even if passed as negative number, flAbs ensures single negation
    expect(buildCommitmentEventDedupKey('decrease', '2023-05-20', -5000000)).toBe(
      'commitment|2023-05-20|-5000000.00000000',
    );
  });

  it('builds paid_in and distribution keys with positive exact amounts', () => {
    expect(buildCommitmentEventDedupKey('paid_in', '2023-06-01', 3000000)).toBe(
      'paid_in|2023-06-01|3000000.00000000',
    );
    expect(buildCommitmentEventDedupKey('distribution', '2023-06-01', 3000000)).toBe(
      'distribution|2023-06-01|3000000.00000000',
    );
    // Distinct from each other
    expect(buildCommitmentEventDedupKey('paid_in', '2023-06-01', 3000000)).not.toBe(
      buildCommitmentEventDedupKey('distribution', '2023-06-01', 3000000),
    );
  });
});

describe('buildLedgerEntryCommitmentDedupKey', () => {
  it('matches proposed increase key against DB commitment entry', () => {
    const entry = {
      entry_type: 'commitment',
      entry_date: '2023-05-20',
      commitment_delta: '10000000.00000000',
    };
    expect(buildLedgerEntryCommitmentDedupKey(entry)).toBe('commitment|2023-05-20|10000000.00000000');
    expect(buildLedgerEntryCommitmentDedupKey(entry)).toBe(
      buildCommitmentEventDedupKey('increase', '2023-05-20', 10000000),
    );
  });

  it('matches proposed decrease key against DB commitment decrease entry', () => {
    const entry = {
      entry_type: 'commitment',
      entry_date: '2023-05-20',
      commitment_delta: '-5000000.00000000',
    };
    expect(buildLedgerEntryCommitmentDedupKey(entry)).toBe('commitment|2023-05-20|-5000000.00000000');
    expect(buildLedgerEntryCommitmentDedupKey(entry)).toBe(
      buildCommitmentEventDedupKey('decrease', '2023-05-20', 5000000),
    );
  });

  it('matches proposed paid_in key against negative cash_delta in DB paid_in entry', () => {
    const entry = {
      entry_type: 'paid_in',
      entry_date: '2023-06-01',
      cash_delta: '-3000000.00000000',
    };
    expect(buildLedgerEntryCommitmentDedupKey(entry)).toBe('paid_in|2023-06-01|3000000.00000000');
    expect(buildLedgerEntryCommitmentDedupKey(entry)).toBe(
      buildCommitmentEventDedupKey('paid_in', '2023-06-01', 3000000),
    );
  });

  it('matches proposed distribution key against positive cash_delta in DB distribution entry', () => {
    const entry = {
      entry_type: 'distribution',
      entry_date: '2023-06-01',
      cash_delta: '3000000.00000000',
    };
    expect(buildLedgerEntryCommitmentDedupKey(entry)).toBe('distribution|2023-06-01|3000000.00000000');
    expect(buildLedgerEntryCommitmentDedupKey(entry)).toBe(
      buildCommitmentEventDedupKey('distribution', '2023-06-01', 3000000),
    );
  });

  it('builds adjustment key with valuation_delta and commitment_delta', () => {
    const entry = {
      entry_type: 'adjustment',
      entry_date: '2023-07-01',
      valuation_delta: '-914781.37000000',
      commitment_delta: '0.00000000',
    };
    expect(buildLedgerEntryCommitmentDedupKey(entry)).toBe(
      'adjustment|2023-07-01|-914781.37000000:0.00000000',
    );
    expect(buildLedgerEntryCommitmentDedupKey(entry)).toBe(
      buildAdjustmentDedupKey('2023-07-01', '-914781.37000000'),
    );
  });
});

describe('buildLedgerEntryCommitmentDedupKey — transferee-only transfers', () => {
  const transferInKey = buildCommitmentEventDedupKey('transfer_in', '2024-10-15', 3000000);

  it('matches a transfer_in proposal against a commitment entry tagged transfer_in', () => {
    expect(transferInKey).toBe('commitment_transfer_in|2024-10-15|3000000.00000000');
    expect(
      buildLedgerEntryCommitmentDedupKey({
        entry_type: 'commitment',
        sub_type: 'transfer_in',
        entry_date: '2024-10-15',
        commitment_delta: '3000000.00000000',
      }),
    ).toBe(transferInKey);
  });

  it('matches a transfer_in proposal against the transferee leg of an earlier two-legged import', () => {
    expect(
      buildLedgerEntryCommitmentDedupKey({
        entry_type: 'commitment_transfer',
        sub_type: 'transfer_in',
        entry_date: '2024-10-15',
        commitment_delta: '3000000.00000000',
        cash_delta: '0.00000000',
      }),
    ).toBe(transferInKey);
  });

  it('keeps the transfer_out leg of a two-legged transfer out of the transfer_in key', () => {
    expect(
      buildLedgerEntryCommitmentDedupKey({
        entry_type: 'commitment_transfer',
        sub_type: 'transfer_out',
        entry_date: '2024-10-15',
        commitment_delta: '-3000000.00000000',
        cash_delta: '0.00000000',
      }),
    ).toBe('commitment_transfer|2024-10-15|0.00000000');
  });

  it('never matches an ordinary commitment increase of the same date and amount', () => {
    expect(buildCommitmentEventDedupKey('increase', '2024-10-15', 3000000)).not.toBe(transferInKey);
    expect(
      buildLedgerEntryCommitmentDedupKey({
        entry_type: 'commitment',
        entry_date: '2024-10-15',
        commitment_delta: '3000000.00000000',
      }),
    ).not.toBe(transferInKey);
  });
});

describe('TransferInReplayGuard.check', () => {
  const key = 'commitment_transfer_in|2024-10-15|1000000.00000000';

  it('posts a row when the ledger has no matching entry', () => {
    expect(new TransferInReplayGuard().check('pos-1', key, 'lp-a', 0)).toBe('new');
  });

  it('lets each matching ledger entry absorb exactly one row', () => {
    const guard = new TransferInReplayGuard();
    expect(guard.check('pos-1', key, 'lp-a', 1)).toBe('duplicate');
    expect(guard.check('pos-1', key, 'lp-b', 1)).toBe('new');
  });

  it('treats a row repeated with the same transferor in one batch as a duplicate', () => {
    const guard = new TransferInReplayGuard();
    expect(guard.check('pos-1', key, 'lp-a', 0)).toBe('new');
    expect(guard.check('pos-1', key, 'lp-a', 1)).toBe('duplicate');
  });

  it('posts same-day, same-amount rows from different transferors', () => {
    const guard = new TransferInReplayGuard();
    expect(guard.check('pos-1', key, 'lp-a', 0)).toBe('new');
    expect(guard.check('pos-1', key, 'lp-b', 1)).toBe('new');
  });

  it('keeps positions apart', () => {
    const guard = new TransferInReplayGuard();
    expect(guard.check('pos-1', key, 'lp-a', 1)).toBe('duplicate');
    expect(guard.check('pos-2', key, 'lp-a', 0)).toBe('new');
  });
});

describe('buildCommitmentTransferDedupKey', () => {
  it('formats transfer dedup key with date, amount, transferor position, and transferee position', () => {
    expect(
      buildCommitmentTransferDedupKey('2023-08-15', 500000, 'pos-transferor-1', 'pos-transferee-2'),
    ).toBe('commitment_transfer|2023-08-15|500000.00000000|pos-transferor-1|pos-transferee-2');
  });

  it('differentiates distinct transferor or transferee positions', () => {
    const base = buildCommitmentTransferDedupKey('2023-08-15', 500000, 'pos-A', 'pos-B');
    expect(base).not.toBe(buildCommitmentTransferDedupKey('2023-08-15', 500000, 'pos-C', 'pos-B'));
    expect(base).not.toBe(buildCommitmentTransferDedupKey('2023-08-15', 500000, 'pos-A', 'pos-D'));
  });
});


it('deduplicates paid-in adjustments separately from valuation adjustments', () => {
  const key = buildAdjustmentDedupKey('2022-12-31', '0.00000000', '0.00000000', '-914781.37');
  expect(buildLedgerEntryCommitmentDedupKey({ entry_date: '2022-12-31', entry_type: 'adjustment',
    commitment_delta: '0.00000000', sub_type: 'paid_in_writeoff', valuation_delta: '-914781.37000000' })).toBe(key);
  expect(key).not.toBe(buildAdjustmentDedupKey('2022-12-31', '-914781.37000000'));
});
