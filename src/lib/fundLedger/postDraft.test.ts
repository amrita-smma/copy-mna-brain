import { describe, expect, it } from 'vitest';
import {
  amountLabelOf,
  amountTargetOf,
  buildPostEventInput,
  draftLegs,
  draftProblem,
  emptyDraft,
  entityKey,
  isDraftPostable,
  isProceedsTreatmentApplicable,
  needsAmount,
  needsUnits,
  offersDecreaseToggle,
  parseEntityKey,
  satisfiesRuleDecimal,
  type EntryDraft,
} from './postDraft';
import {
  SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
  SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
} from '@/lib/sellProceedsDestination';

const TODAY = '2026-08-31';

const draft = (parts: Partial<EntryDraft>): EntryDraft => ({
  ...emptyDraft(TODAY),
  ...parts,
});

describe('entityKey / parseEntityKey', () => {
  it('round-trips a kind and an id', () => {
    expect(parseEntityKey(entityKey('fund', 'abc'))).toEqual({ kind: 'fund', id: 'abc' });
  });

  it('keeps a UUID intact even though it has no colon problem', () => {
    const id = '3f1b0a52-0000-4000-8000-000000000001';
    expect(parseEntityKey(entityKey('asset', id))?.id).toBe(id);
  });

  it('rejects anything that is not a key', () => {
    expect(parseEntityKey('')).toBeNull();
    expect(parseEntityKey('fund')).toBeNull();
    expect(parseEntityKey('fund:')).toBeNull();
    expect(parseEntityKey(':abc')).toBeNull();
    expect(parseEntityKey('company:abc')).toBeNull();
  });
});

describe('field gating', () => {
  it('points the amount box at cash for the types that move money', () => {
    expect(amountTargetOf('buy')).toBe('cash');
    expect(amountTargetOf('distribution')).toBe('cash');
  });

  it('points it at commitment for the types that only move a pledge', () => {
    expect(amountTargetOf('commitment')).toBe('commitment');
  });

  it('points an adjustment at the valuation column, as a paid-in write-off', () => {
    expect(amountTargetOf('adjustment')).toBe('valuation');
  });

  it('labels the box by what the type actually does', () => {
    expect(amountLabelOf('buy')).toBe('Cash paid');
    expect(amountLabelOf('distribution')).toBe('Cash received');
    expect(amountLabelOf('commitment')).toBe('Amount pledged');
    // The label follows the kind of adjustment the position allows: a fund
    // stake can be written off, anything else can only be restated.
    expect(amountLabelOf('adjustment', 'paid_in_writeoff', 'fund')).toBe('Write-off amount');
    expect(amountLabelOf('adjustment', 'valuation_restatement', 'fund')).toBe(
      'Restatement amount',
    );
    expect(amountLabelOf('adjustment', 'paid_in_writeoff', 'asset')).toBe('Restatement amount');
    // Before a position is chosen the write-off leads, since none can post yet.
    expect(amountLabelOf('adjustment')).toBe('Write-off amount');
  });

  it('enables the units box only for the types that change unit counts', () => {
    expect(needsUnits('buy')).toBe(true);
    expect(needsUnits('redemption')).toBe(true);
    expect(needsUnits('commitment')).toBe(false);
    expect(needsUnits('income')).toBe(false);
  });

  it('never offers units for an adjustment, which only moves paid-in capital', () => {
    expect(needsUnits('adjustment')).toBe(false);
  });

  it('enables the amount box for every type that moves something', () => {
    expect(needsAmount('buy')).toBe(true);
    expect(needsAmount('commitment')).toBe(true);
    expect(needsAmount('adjustment')).toBe(true);
  });

  it('offers a decrease toggle only where the rule allows either sign', () => {
    expect(offersDecreaseToggle('commitment')).toBe(true);
    // An adjustment states its direction through `adjustmentDirectionOptions`.
    expect(offersDecreaseToggle('adjustment')).toBe(false);
    // Buys and distributions have a fixed sign; the type has already decided.
    expect(offersDecreaseToggle('buy')).toBe(false);
    expect(offersDecreaseToggle('distribution')).toBe(false);
    // Transfers derive both legs from one magnitude.
    expect(offersDecreaseToggle('commitment_transfer')).toBe(false);
  });
});

describe('satisfiesRuleDecimal', () => {
  it('treats a signed zero as zero rather than as negative', () => {
    expect(satisfiesRuleDecimal('zero', '-0.00000000')).toBe(true);
    expect(satisfiesRuleDecimal('negative', '-0.00000000')).toBe(false);
    expect(satisfiesRuleDecimal('nonzero', '-0.00000000')).toBe(false);
  });

  it('checks each rule against an exact decimal', () => {
    expect(satisfiesRuleDecimal('positive', '0.00000001')).toBe(true);
    expect(satisfiesRuleDecimal('non_positive', '0')).toBe(true);
    expect(satisfiesRuleDecimal('non_negative', '-1')).toBe(false);
    expect(satisfiesRuleDecimal('free', '-12345')).toBe(true);
  });

  it('mirrors directional rules when isReversal is true', () => {
    expect(satisfiesRuleDecimal('positive', '-0.00000001', true)).toBe(true);
    expect(satisfiesRuleDecimal('positive', '0.00000001', true)).toBe(false);
    expect(satisfiesRuleDecimal('negative', '0.00000001', true)).toBe(true);
    expect(satisfiesRuleDecimal('negative', '-0.00000001', true)).toBe(false);
    expect(satisfiesRuleDecimal('non_positive', '1', true)).toBe(true);
    expect(satisfiesRuleDecimal('non_negative', '-1', true)).toBe(true);
  });
});

describe('draftLegs', () => {
  it('signs a buy as cash out, units in — never from the keyboard', () => {
    const [leg] = draftLegs(
      draft({ type: 'buy', positionId: 'pos-1', amount: '43780000', units: '9500000' }),
    );
    expect(leg.cashDelta).toBe('-43780000.00000000');
    expect(leg.quantityDelta).toBe('9500000.00000000');
    expect(leg.commitmentDelta).toBe('0.00000000');
  });

  it('ignores a minus the user typed and applies the type sign instead', () => {
    const [leg] = draftLegs(draft({ type: 'buy', positionId: 'pos-1', amount: '-43780000' }));
    expect(leg.cashDelta).toBe('-43780000.00000000');
  });

  it('signs a distribution as cash in', () => {
    const [leg] = draftLegs(draft({ type: 'distribution', positionId: 'pos-1', amount: '3200000' }));
    expect(leg.cashDelta).toBe('3200000.00000000');
  });

  it('signs a redemption as units out and cash in', () => {
    const [leg] = draftLegs(
      draft({ type: 'redemption', positionId: 'pos-1', amount: '880000', units: '800000' }),
    );
    expect(leg.quantityDelta).toBe('-800000.00000000');
    expect(leg.cashDelta).toBe('880000.00000000');
  });

  it('puts a commitment on the commitment column with no cash', () => {
    const [leg] = draftLegs(draft({ type: 'commitment', positionId: 'pos-1', amount: '50000000' }));
    expect(leg.commitmentDelta).toBe('50000000.00000000');
    expect(leg.cashDelta).toBe('0.00000000');
    expect(leg.quantityDelta).toBe('0.00000000');
  });

  it('lets the decrease toggle reduce a pledge', () => {
    const [leg] = draftLegs(
      draft({ type: 'commitment', positionId: 'pos-1', amount: '5000000', decrease: true }),
    );
    expect(leg.commitmentDelta).toBe('-5000000.00000000');
  });

  it('writes an adjustment as a signed paid-in delta, touching nothing else', () => {
    const [reduce] = draftLegs(
      draft({ type: 'adjustment', positionId: 'pos-1', amount: '914781.37', decrease: true }),
    );
    expect(reduce.valuationDelta).toBe('-914781.37000000');
    expect(reduce.commitmentDelta).toBe('0.00000000');
    expect(reduce.quantityDelta).toBe('0.00000000');
    expect(reduce.cashDelta).toBe('0.00000000');

    const [add] = draftLegs(
      draft({ type: 'adjustment', positionId: 'pos-1', amount: '914781.37', decrease: false }),
    );
    expect(add.valuationDelta).toBe('914781.37000000');
  });

  it('ignores a stale units value on an adjustment', () => {
    const [leg] = draftLegs(
      draft({ type: 'adjustment', positionId: 'pos-1', amount: '5000', units: '330000' }),
    );
    expect(leg.quantityDelta).toBe('0.00000000');
  });

  it('leaves a fixed-sign type alone when the toggle is set', () => {
    const [leg] = draftLegs(
      draft({ type: 'buy', positionId: 'pos-1', amount: '1000', decrease: true }),
    );
    expect(leg.cashDelta).toBe('-1000.00000000');
  });

  it('keeps eight decimals exactly rather than rounding through a double', () => {
    const [leg] = draftLegs(
      draft({ type: 'buy', positionId: 'pos-1', amount: '0.1', units: '0.00000003' }),
    );
    expect(leg.cashDelta).toBe('-0.10000000');
    expect(leg.quantityDelta).toBe('0.00000003');
  });

  it('reads a half-typed amount as nothing rather than throwing', () => {
    const [leg] = draftLegs(draft({ type: 'buy', positionId: 'pos-1', amount: 'abc' }));
    expect(leg.cashDelta).toBe('0.00000000');
  });

  it('writes two mirrored legs for a commitment transfer, each naming the other', () => {
    const legs = draftLegs(
      draft({
        type: 'commitment_transfer',
        fromPositionId: 'pos-a',
        toPositionId: 'pos-b',
        amount: '5000000',
        consideration: '5150000',
      }),
    );
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({
      positionId: 'pos-a',
      commitmentDelta: '-5000000.00000000',
      // The giver receives the consideration.
      cashDelta: '5150000.00000000',
      counterpartyPositionId: 'pos-b',
    });
    expect(legs[1]).toMatchObject({
      positionId: 'pos-b',
      commitmentDelta: '5000000.00000000',
      cashDelta: '-5150000.00000000',
      counterpartyPositionId: 'pos-a',
    });
  });

  it('nets both transfer legs to zero on every column', () => {
    const legs = draftLegs(
      draft({
        type: 'unit_transfer',
        fromPositionId: 'pos-a',
        toPositionId: 'pos-b',
        units: '1500000',
        consideration: '1650000',
      }),
    );
    const sum = (values: string[]) =>
      values.reduce((total, value) => total + Number(value), 0);
    expect(sum(legs.map((leg) => leg.quantityDelta))).toBe(0);
    expect(sum(legs.map((leg) => leg.cashDelta))).toBe(0);
    expect(sum(legs.map((leg) => leg.commitmentDelta))).toBe(0);
  });

  it('allows a transfer with no consideration recorded', () => {
    const legs = draftLegs(
      draft({
        type: 'unit_transfer',
        fromPositionId: 'pos-a',
        toPositionId: 'pos-b',
        units: '1000',
      }),
    );
    expect(legs[0].cashDelta).toBe('0.00000000');
    expect(legs[1].cashDelta).toBe('0.00000000');
  });
});

describe('draftProblem', () => {
  it('passes a complete single-legged draft', () => {
    expect(
      draftProblem(draft({ type: 'buy', positionId: 'pos-1', amount: '1000', units: '100' })),
    ).toBeNull();
  });

  it('asks for a position first', () => {
    expect(draftProblem(draft({ type: 'buy', amount: '1000' }))).toMatch(/Pick a position/);
  });

  it('asks for an amount when nothing would move', () => {
    expect(draftProblem(draft({ type: 'buy', positionId: 'pos-1' }))).toMatch(/Enter an amount/);
  });

  it('accepts a buy with no units — some sources never recorded a share count', () => {
    expect(
      draftProblem(draft({ type: 'buy', positionId: 'pos-1', amount: '1000' })),
    ).toBeNull();
  });

  it('rejects a redemption with no units, which the service also refuses', () => {
    // redemption requires quantity_delta < 0.
    expect(
      draftProblem(draft({ type: 'redemption', positionId: 'pos-1', amount: '880000' })),
    ).toMatch(/cannot move units/);
  });

  it('accepts an adjustment whose only movement is the paid-in delta', () => {
    expect(
      draftProblem(
        draft({ type: 'adjustment', positionId: 'pos-1', amount: '914781.37', decrease: true }),
      ),
    ).toBeNull();
  });

  it('still rejects an adjustment carrying only units, which now post nothing', () => {
    expect(
      draftProblem(draft({ type: 'adjustment', positionId: 'pos-1', units: '330000' })),
    ).toMatch(/Enter an amount/);
  });

  it('rejects an empty adjustment, which would post a row that does nothing', () => {
    expect(draftProblem(draft({ type: 'adjustment', positionId: 'pos-1' }))).toMatch(
      /Enter an amount/,
    );
  });

  it('needs a position on each side of a transfer', () => {
    expect(
      draftProblem(draft({ type: 'unit_transfer', fromPositionId: 'pos-a', units: '10' })),
    ).toMatch(/position on each side/);
  });

  it('refuses a transfer between one position and itself', () => {
    expect(
      draftProblem(
        draft({
          type: 'unit_transfer',
          fromPositionId: 'pos-a',
          toPositionId: 'pos-a',
          units: '10',
        }),
      ),
    ).toMatch(/two different positions/);
  });

  it('needs something to actually move on a transfer', () => {
    expect(
      draftProblem(
        draft({
          type: 'commitment_transfer',
          fromPositionId: 'pos-a',
          toPositionId: 'pos-b',
          consideration: '100',
        }),
      ),
    ).toMatch(/commitment being transferred/);
  });

  it('rejects a managed fund sell with unstated proceeds destination', () => {
    const sellDraft = draft({
      type: 'sell',
      positionId: 'pos-1',
      to: 'fund:managed-fund',
      holderFundManaged: true,
      amount: '1000',
    });
    expect(draftProblem(sellDraft)).toBe('Choose a proceeds destination before posting.');
    expect(isDraftPostable(sellDraft)).toBe(false);
  });

  it('rejects a managed fund sell with arbitrary/unrecognized subtype', () => {
    const sellDraft = draft({
      type: 'sell',
      positionId: 'pos-1',
      to: 'fund:managed-fund',
      holderFundManaged: true,
      amount: '1000',
      subType: 'secondary',
    });
    expect(draftProblem(sellDraft)).toBe('Choose a proceeds destination before posting.');
    expect(isDraftPostable(sellDraft)).toBe(false);
  });

  it('accepts a managed fund sell with explicit cash_in_fund destination', () => {
    const sellDraft = draft({
      type: 'sell',
      positionId: 'pos-1',
      to: 'fund:managed-fund',
      holderFundManaged: true,
      amount: '1000',
      subType: SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
    });
    expect(draftProblem(sellDraft)).toBeNull();
    expect(isDraftPostable(sellDraft)).toBe(true);
  });

  it('accepts a managed fund sell with explicit distributed_to_investor destination', () => {
    const sellDraft = draft({
      type: 'sell',
      positionId: 'pos-1',
      to: 'fund:managed-fund',
      holderFundManaged: true,
      amount: '1000',
      subType: SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
    });
    expect(draftProblem(sellDraft)).toBeNull();
    expect(isDraftPostable(sellDraft)).toBe(true);
  });

  it('accepts an investor sell with no subtype as an ordinary sale', () => {
    const investorSellDraft = draft({
      type: 'sell',
      positionId: 'pos-1',
      to: 'investor:inv-1',
      amount: '1000',
      subType: '',
    });
    expect(draftProblem(investorSellDraft)).toBeNull();
    expect(isDraftPostable(investorSellDraft)).toBe(true);
    expect(
      isProceedsTreatmentApplicable({
        entryType: 'sell',
        holder: { holder_investor_id: 'inv-1' },
      }),
    ).toBe(false);
  });

  it('accepts an unmanaged fund sell with no subtype as an ordinary sale', () => {
    const unmanagedFundSellDraft = draft({
      type: 'sell',
      positionId: 'pos-1',
      to: 'fund:unmanaged-fund',
      holderFundManaged: false,
      amount: '1000',
      subType: '',
    });
    expect(draftProblem(unmanagedFundSellDraft)).toBeNull();
    expect(isDraftPostable(unmanagedFundSellDraft)).toBe(true);
    expect(
      isProceedsTreatmentApplicable({
        entryType: 'sell',
        holder: { holder_fund_id: 'unmanaged-fund', holderFundManaged: false },
      }),
    ).toBe(false);
  });

  it('requires proceeds destination for managed fund redemption', () => {
    const fundRedemption = draft({
      type: 'redemption',
      positionId: 'pos-1',
      to: 'fund:target-fund',
      holderFundManaged: true,
      amount: '500000',
      units: '10000',
    });
    expect(draftProblem(fundRedemption)).toBe('Choose a proceeds destination before posting.');
    expect(isDraftPostable(fundRedemption)).toBe(false);

    const validRedemptionCash = draft({
      ...fundRedemption,
      subType: SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
    });
    expect(draftProblem(validRedemptionCash)).toBeNull();
    expect(isDraftPostable(validRedemptionCash)).toBe(true);

    const validRedemptionDistributed = draft({
      ...fundRedemption,
      subType: SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
    });
    expect(draftProblem(validRedemptionDistributed)).toBeNull();
    expect(isDraftPostable(validRedemptionDistributed)).toBe(true);
  });

  it('requires proceeds destination for managed fund distribution', () => {
    const fundDistribution = draft({
      type: 'distribution',
      positionId: 'pos-1',
      to: 'fund:target-fund',
      holderFundManaged: true,
      amount: '500000',
    });
    expect(draftProblem(fundDistribution)).toBe('Choose a proceeds destination before posting.');
    expect(isDraftPostable(fundDistribution)).toBe(false);

    const validDistCash = draft({
      ...fundDistribution,
      subType: SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
    });
    expect(draftProblem(validDistCash)).toBeNull();
    expect(isDraftPostable(validDistCash)).toBe(true);

    const validDistDistributed = draft({
      ...fundDistribution,
      subType: SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
    });
    expect(draftProblem(validDistDistributed)).toBeNull();
    expect(isDraftPostable(validDistDistributed)).toBe(true);
  });

  it('does not require proceeds destination for investor redemption or distribution', () => {
    const investorRedemption = draft({
      type: 'redemption',
      positionId: 'pos-1',
      to: 'investor:inv-1',
      amount: '500000',
      units: '10000',
      subType: '',
    });
    expect(draftProblem(investorRedemption)).toBeNull();
    expect(isDraftPostable(investorRedemption)).toBe(true);

    const investorDistribution = draft({
      type: 'distribution',
      positionId: 'pos-1',
      to: 'investor:inv-1',
      amount: '500000',
      subType: 'dividend',
    });
    expect(draftProblem(investorDistribution)).toBeNull();
    expect(isDraftPostable(investorDistribution)).toBe(true);
  });

  it('agrees with isDraftPostable', () => {
    const good = draft({ type: 'buy', positionId: 'pos-1', amount: '1000' });
    const bad = draft({ type: 'buy', amount: '1000' });
    expect(isDraftPostable(good)).toBe(true);
    expect(isDraftPostable(bad)).toBe(false);
  });
});

describe('buildPostEventInput', () => {
  it('stamps a chosen adjustment sub-type, ignoring free text', () => {
    const payload = buildPostEventInput(
      draft({
        type: 'adjustment',
        positionId: 'pos-1',
        amount: '914781.37',
        decrease: true,
        instrumentKind: 'fund',
        subType: 'whatever the user typed',
      }),
      'Paid-in write-off',
    );
    // The sub-type decides whether valuation_delta reads as paid-in capital, so
    // it comes from the closed set, never from what was typed.
    expect(payload.entries[0]).toMatchObject({
      entry_type: 'adjustment',
      sub_type: 'paid_in_writeoff',
      valuation_delta: '-914781.37000000',
      commitment_delta: '0.00000000',
      quantity_delta: '0.00000000',
      cash_delta: '0.00000000',
    });
  });

  it('keeps a paid-in write-off off a position that has no paid-in capital', () => {
    const payload = buildPostEventInput(
      draft({
        type: 'adjustment',
        positionId: 'pos-1',
        amount: '5000',
        instrumentKind: 'asset',
        subType: 'paid_in_writeoff',
      }),
      'Adjustment',
    );
    // On an asset a write-off would restate cost basis and MOIC, so the draft
    // coerces to a restatement rather than posting what it was handed.
    expect(payload.entries[0].sub_type).toBe('valuation_restatement');
  });

  it('withholds a write-off from a position it cannot resolve', () => {
    const payload = buildPostEventInput(
      draft({
        type: 'adjustment',
        positionId: 'pos-1',
        amount: '5000',
        instrumentKind: 'unknown',
        subType: 'paid_in_writeoff',
      }),
      'Adjustment',
    );
    expect(payload.entries[0].sub_type).toBe('valuation_restatement');
  });

  it('posts the reviewer-chosen restatement on a fund stake', () => {
    const payload = buildPostEventInput(
      draft({
        type: 'adjustment',
        positionId: 'pos-1',
        amount: '5000',
        instrumentKind: 'fund',
        subType: 'valuation_restatement',
      }),
      'Adjustment',
    );
    expect(payload.entries[0].sub_type).toBe('valuation_restatement');
  });

  it('sends a zero valuation delta for every other type', () => {
    const payload = buildPostEventInput(
      draft({ type: 'buy', positionId: 'pos-1', amount: '1000', units: '10' }),
      'Buy',
    );
    expect(payload.entries[0].valuation_delta).toBe('0.00000000');
    expect(payload.entries[0].sub_type).toBeNull();
  });

  it('builds a single-entry payload', () => {
    const payload = buildPostEventInput(
      draft({
        type: 'buy',
        positionId: 'pos-1',
        amount: '43780000',
        units: '9500000',
        subType: ' initial ',
        notes: '  Series E  ',
      }),
      'Investment — GOTO Group',
    );
    expect(payload.event_date).toBe(TODAY);
    expect(payload.description).toBe('Investment — GOTO Group');
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0]).toMatchObject({
      position_id: 'pos-1',
      entry_date: TODAY,
      entry_type: 'buy',
      sub_type: 'initial',
      notes: 'Series E',
      currency: 'USD',
      cash_delta: '-43780000.00000000',
      counterparty_position_id: null,
    });
  });

  it('sends null rather than an empty string for an unfilled sub-type or note', () => {
    const payload = buildPostEventInput(
      draft({ type: 'buy', positionId: 'pos-1', amount: '100', subType: '   ' }),
      'Buy',
    );
    expect(payload.entries[0].sub_type).toBeNull();
    expect(payload.entries[0].notes).toBeNull();
  });

  it('sends both transfer legs, each naming the other as counterparty', () => {
    const payload = buildPostEventInput(
      draft({
        type: 'unit_transfer',
        fromPositionId: 'pos-a',
        toPositionId: 'pos-b',
        units: '1500000',
        consideration: '1650000',
      }),
      'Unit transfer',
    );
    expect(payload.entries).toHaveLength(2);
    expect(payload.entries[0].counterparty_position_id).toBe('pos-b');
    expect(payload.entries[1].counterparty_position_id).toBe('pos-a');
  });

  it('sends no funding allocations — the service derives them from the position', () => {
    const payload = buildPostEventInput(
      draft({ type: 'buy', positionId: 'pos-1', amount: '100' }),
      'Buy',
    );
    expect(payload.allocations).toBeUndefined();
    expect(payload.entries[0]).not.toHaveProperty('allocations');
  });

  it('drops a leg with no position rather than posting an orphan row', () => {
    const payload = buildPostEventInput(
      draft({ type: 'unit_transfer', fromPositionId: 'pos-a', units: '10' }),
      'Unit transfer',
    );
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0].position_id).toBe('pos-a');
  });

  it('writes proceeds destination for managed fund sell', () => {
    const payload = buildPostEventInput(
      draft({
        type: 'sell',
        positionId: 'pos-1',
        to: 'fund:managed-fund',
        holderFundManaged: true,
        amount: '1000',
        subType: SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
      }),
      'Managed fund sell',
    );
    expect(payload.entries[0].sub_type).toBe(SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR);
  });

  it('strips stale destination to null for investor sell', () => {
    const payload = buildPostEventInput(
      draft({
        type: 'sell',
        positionId: 'pos-1',
        to: 'investor:inv-1',
        amount: '1000',
        subType: SUB_TYPE_DIVESTMENT_CASH_IN_FUND,
      }),
      'Investor sell with stale destination',
    );
    expect(payload.entries[0].sub_type).toBeNull();
  });

  it('strips stale destination to null for unmanaged fund sell', () => {
    const payload = buildPostEventInput(
      draft({
        type: 'sell',
        positionId: 'pos-1',
        to: 'fund:unmanaged-fund',
        holderFundManaged: false,
        amount: '1000',
        subType: SUB_TYPE_DIVESTMENT_DISTRIBUTED_TO_INVESTOR,
      }),
      'Unmanaged fund sell with stale destination',
    );
    expect(payload.entries[0].sub_type).toBeNull();
  });
});
