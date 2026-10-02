import { describe, expect, it } from 'vitest';
import {
  computeDirectOwnershipChange,
  computeFundingRound,
  findStaleFundingRounds,
  positionsMissingFollowOnEntry,
  readShareholdingPct,
  validateDirectOwnershipChange,
  validateFundingRound,
} from './fundingRound';

describe('computeFundingRound', () => {
  it('dilutes a non-participating position by pre-money / post-money', () => {
    // 80M pre, 20M raised → 100M post; a 10% holder that sits out drops to 8%.
    const result = computeFundingRound(
      { preMoney: '80000000', roundSize: '20000000' },
      [{ positionId: 'p1', preRoundPct: '10', participationAmount: '0' }],
    );

    expect(result.postMoney).toBe('100000000.00000000');
    expect(result.dilutionFactor).toBe('0.80000000');
    const [p1] = result.participants;
    expect(p1.pctWithoutParticipation).toBe('8.00000000');
    expect(p1.computedPct).toBe('8.00000000');
    expect(p1.effectivePct).toBe('8.00000000');
    expect(p1.value).toBe('8000000.00000000');
    expect(p1.overridden).toBe(false);
  });

  it('adds the follow-on amount to the stake it buys', () => {
    // 10% of 80M = 8M owned + 2M follow-on = 10M of a 100M post → 10%.
    const result = computeFundingRound(
      { preMoney: '80000000', roundSize: '20000000' },
      [{ positionId: 'p1', preRoundPct: '10', participationAmount: '2000000' }],
    );

    const [p1] = result.participants;
    expect(p1.pctWithoutParticipation).toBe('8.00000000');
    expect(p1.computedPct).toBe('10.00000000');
    expect(p1.value).toBe('10000000.00000000');
    expect(result.totalParticipation).toBe('2000000.00000000');
  });

  it('dilutes every one of our funds by the same factor in a multi-fund round', () => {
    const result = computeFundingRound(
      { preMoney: '150000000', roundSize: '50000000' },
      [
        { positionId: 'fund-a', preRoundPct: '12', participationAmount: '5000000' },
        { positionId: 'fund-b', preRoundPct: '4', participationAmount: '0' },
      ],
    );

    expect(result.dilutionFactor).toBe('0.75000000');
    const byId = Object.fromEntries(result.participants.map((p) => [p.positionId, p]));
    // Fund A: (12% × 150M + 5M) / 200M = 23M / 200M = 11.5%.
    expect(byId['fund-a'].computedPct).toBe('11.50000000');
    expect(byId['fund-a'].value).toBe('23000000.00000000');
    // Fund B: 4% × 0.75 = 3%.
    expect(byId['fund-b'].computedPct).toBe('3.00000000');
    expect(byId['fund-b'].value).toBe('6000000.00000000');
  });

  it('marks a position down in a down round with the same formula', () => {
    // Last post-money was 100M (10% = 10M); the next round prices at 40M pre.
    const result = computeFundingRound(
      { preMoney: '40000000', roundSize: '10000000' },
      [{ positionId: 'p1', preRoundPct: '10', participationAmount: '0' }],
    );

    const [p1] = result.participants;
    expect(p1.computedPct).toBe('8.00000000');
    expect(p1.value).toBe('4000000.00000000');
  });

  it('keeps the stake unchanged in a zero-size round (a re-price only)', () => {
    const result = computeFundingRound(
      { preMoney: '60000000', roundSize: '0' },
      [{ positionId: 'p1', preRoundPct: '25', participationAmount: '0' }],
    );

    expect(result.participants[0].computedPct).toBe('25.00000000');
    expect(result.participants[0].value).toBe('15000000.00000000');
  });

  it('values the position at the overridden stake when one is given', () => {
    const result = computeFundingRound(
      { preMoney: '40000000', roundSize: '10000000' },
      [
        {
          positionId: 'p1',
          preRoundPct: '10',
          participationAmount: '0',
          overridePct: '9.5',
          overrideRemark: 'Anti-dilution top-up per SHA clause 7',
        },
      ],
    );

    const [p1] = result.participants;
    expect(p1.computedPct).toBe('8.00000000');
    expect(p1.effectivePct).toBe('9.50000000');
    expect(p1.overridden).toBe(true);
    expect(p1.value).toBe('4750000.00000000');
  });

  it('throws when the input is invalid', () => {
    expect(() =>
      computeFundingRound({ preMoney: '0', roundSize: '10' }, [
        { positionId: 'p1', preRoundPct: '10', participationAmount: '0' },
      ]),
    ).toThrow(/Pre-money/);
  });
});

describe('validateFundingRound', () => {
  const ok = { positionId: 'p1', preRoundPct: '10', participationAmount: '0' };

  it('returns no errors for a valid round', () => {
    expect(validateFundingRound({ preMoney: '100', roundSize: '10' }, [ok])).toEqual([]);
  });

  it('rejects a non-positive or non-numeric pre-money', () => {
    expect(validateFundingRound({ preMoney: '0', roundSize: '10' }, [ok])).toContain(
      'Pre-money valuation must be greater than zero.',
    );
    expect(validateFundingRound({ preMoney: 'abc', roundSize: '10' }, [ok])).toContain(
      'Pre-money valuation must be greater than zero.',
    );
  });

  it('rejects a negative round size', () => {
    expect(validateFundingRound({ preMoney: '100', roundSize: '-1' }, [ok])).toContain(
      'Round size must be zero or more.',
    );
  });

  it('rejects a round with no positions', () => {
    expect(validateFundingRound({ preMoney: '100', roundSize: '10' }, [])).toContain(
      'A round must re-mark at least one position.',
    );
  });

  it('rejects a stake outside 0–100%', () => {
    expect(
      validateFundingRound({ preMoney: '100', roundSize: '10' }, [{ ...ok, preRoundPct: '101' }]),
    ).toContain('Each pre-round stake must be between 0% and 100%.');
  });

  it('rejects follow-on amounts that exceed the round size', () => {
    expect(
      validateFundingRound({ preMoney: '100', roundSize: '10' }, [
        { ...ok, participationAmount: '6' },
        { positionId: 'p2', preRoundPct: '5', participationAmount: '5' },
      ]),
    ).toContain('Our follow-on amounts add up to more than the round size.');
  });

  it('rejects the same position twice', () => {
    expect(validateFundingRound({ preMoney: '100', roundSize: '10' }, [ok, ok])).toContain(
      'Position p1 appears more than once.',
    );
  });

  it('requires a remark and an in-range value for an overridden stake', () => {
    const errors = validateFundingRound({ preMoney: '100', roundSize: '10' }, [
      { ...ok, overridePct: '150', overrideRemark: '  ' },
    ]);
    expect(errors).toContain('An overridden stake must be between 0% and 100%.');
    expect(errors).toContain('An overridden stake needs a remark explaining why.');
  });

  it('treats a blank override as no override', () => {
    expect(
      validateFundingRound({ preMoney: '100', roundSize: '10' }, [{ ...ok, overridePct: ' ' }]),
    ).toEqual([]);
  });
});

describe('findStaleFundingRounds', () => {
  it('flags nothing when each round starts from the stake the previous one left', () => {
    const stale = findStaleFundingRounds([
      {
        id: 'r1',
        roundDate: '2025-01-01',
        createdAt: '2025-01-02T00:00:00Z',
        changes: [{ positionId: 'p1', preRoundPct: '10', effectivePct: '8' }],
      },
      {
        id: 'r2',
        roundDate: '2025-06-01',
        createdAt: '2025-06-02T00:00:00Z',
        changes: [{ positionId: 'p1', preRoundPct: '8.00000000', effectivePct: '6' }],
      },
    ]);
    expect(stale.size).toBe(0);
  });

  it('flags a later round whose starting stake no longer matches an edited earlier round', () => {
    const stale = findStaleFundingRounds([
      {
        id: 'r2',
        roundDate: '2025-06-01',
        createdAt: '2025-06-02T00:00:00Z',
        changes: [{ positionId: 'p1', preRoundPct: '8', effectivePct: '6' }],
      },
      {
        id: 'r1',
        roundDate: '2025-01-01',
        createdAt: '2025-01-02T00:00:00Z',
        // Edited: now leaves p1 at 7.5% instead of the 8% r2 was entered against.
        changes: [{ positionId: 'p1', preRoundPct: '10', effectivePct: '7.5' }],
      },
    ]);
    expect([...stale]).toEqual(['r2']);
  });

  it('does not flag a round for a position no earlier round touched', () => {
    const stale = findStaleFundingRounds([
      {
        id: 'r1',
        roundDate: '2025-01-01',
        createdAt: '2025-01-02T00:00:00Z',
        changes: [{ positionId: 'p1', preRoundPct: '10', effectivePct: '8' }],
      },
      {
        id: 'r2',
        roundDate: '2025-06-01',
        createdAt: '2025-06-02T00:00:00Z',
        changes: [{ positionId: 'p2', preRoundPct: '3', effectivePct: '2' }],
      },
    ]);
    expect(stale.size).toBe(0);
  });
});

describe('positionsMissingFollowOnEntry', () => {
  it('returns participating positions with no buy entry near the round date', () => {
    const missing = positionsMissingFollowOnEntry(
      '2025-06-15',
      [
        { positionId: 'has-buy', participationAmount: '100' },
        { positionId: 'no-buy', participationAmount: '50' },
        { positionId: 'sat-out', participationAmount: '0' },
      ],
      [
        { position_id: 'has-buy', entry_type: 'buy', entry_date: '2025-07-01' },
        { position_id: 'no-buy', entry_type: 'buy', entry_date: '2024-01-01' },
        { position_id: 'no-buy', entry_type: 'distribution', entry_date: '2025-06-15' },
      ],
    );
    expect(missing).toEqual(['no-buy']);
  });
});

describe('readShareholdingPct', () => {
  it('reads the stake a quarterly mark carries in its source_meta notes', () => {
    expect(readShareholdingPct('Q1 | source_meta: {"period_label":"Q1","shareholding_pct":11.5}')).toBe(
      '11.50000000',
    );
  });

  it('returns null for notes without a stake', () => {
    expect(readShareholdingPct(null)).toBeNull();
    expect(readShareholdingPct('plain remark')).toBeNull();
    expect(readShareholdingPct('x | source_meta: {"period_label":"Q1"}')).toBeNull();
    expect(readShareholdingPct('x | source_meta: not-json')).toBeNull();
  });
});

describe('validateDirectOwnershipChange', () => {
  it('accepts an opening stake without a stake before', () => {
    expect(validateDirectOwnershipChange('opening_stake', [{ positionId: 'p', preRoundPct: '', pctAfter: '6' }])).toEqual(
      [],
    );
  });

  it('requires a stake before for another corporate action', () => {
    expect(validateDirectOwnershipChange('other', [{ positionId: 'p', preRoundPct: '', pctAfter: '6' }])).toEqual([
      'Each stake before must be between 0% and 100%.',
    ]);
  });

  it('rejects a stake after outside 0–100%, no positions and duplicates', () => {
    expect(validateDirectOwnershipChange('opening_stake', [{ positionId: 'p', preRoundPct: '0', pctAfter: '101' }])).toEqual([
      'Each opening stake must be between 0% and 100%.',
    ]);
    expect(validateDirectOwnershipChange('other', [])).toEqual(['An action must change at least one position.']);
    expect(
      validateDirectOwnershipChange('other', [
        { positionId: 'p', preRoundPct: '5', pctAfter: '4' },
        { positionId: 'p', preRoundPct: '5', pctAfter: '4' },
      ]),
    ).toEqual(['Position p appears more than once.']);
  });
});

describe('computeDirectOwnershipChange', () => {
  it('starts an opening stake from 0% and keeps the stake after as entered', () => {
    expect(
      computeDirectOwnershipChange('opening_stake', [{ positionId: 'p', preRoundPct: '9', pctAfter: '6' }]),
    ).toEqual([{ positionId: 'p', preRoundPct: '0.00000000', pctAfter: '6.00000000' }]);
  });

  it('keeps both stakes of another action as entered', () => {
    expect(computeDirectOwnershipChange('other', [{ positionId: 'p', preRoundPct: '6', pctAfter: '5.5' }])).toEqual([
      { positionId: 'p', preRoundPct: '6.00000000', pctAfter: '5.50000000' },
    ]);
  });

  it('throws when validation fails', () => {
    expect(() => computeDirectOwnershipChange('other', [])).toThrow(RangeError);
  });
});

describe('findStaleFundingRounds with an opening stake', () => {
  it('never flags an opening stake, and chains the next action from it', () => {
    const stale = findStaleFundingRounds([
      {
        id: 'r1',
        roundDate: '2024-01-31',
        createdAt: '2024-02-01T00:00:00Z',
        changes: [{ positionId: 'p', preRoundPct: '10', effectivePct: '8' }],
      },
      {
        id: 'open',
        roundDate: '2024-06-30',
        createdAt: '2024-07-01T00:00:00Z',
        resetsChain: true,
        changes: [{ positionId: 'p', preRoundPct: '0', effectivePct: '6' }],
      },
      {
        id: 'r2',
        roundDate: '2025-01-31',
        createdAt: '2025-02-01T00:00:00Z',
        changes: [{ positionId: 'p', preRoundPct: '6', effectivePct: '4.8' }],
      },
    ]);
    expect([...stale]).toEqual([]);
  });
});
