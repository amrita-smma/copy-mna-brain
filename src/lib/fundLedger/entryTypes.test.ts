import { describe, expect, it } from 'vitest';
import {
  ENTRY_TYPES,
  ENTRY_TYPE_KEYS,
  allowsPositionKind,
  entryTypeLabel,
  entryTypeShortLabel,
  entryTypeSpec,
  isTwoLegged,
  mirrorRuleForReversal,
  ruleGlyph,
  ruleIsFixedZero,
  satisfiesRule,
  signedForRule,
  type FlEntryType,
} from './entryTypes';

describe('ENTRY_TYPES', () => {
  it('covers every fl_entry_type enum member', () => {
    expect(ENTRY_TYPE_KEYS).toEqual([
      'commitment',
      'commitment_transfer',
      'paid_in',
      'distribution',
      'redemption',
      'unit_transfer',
      'buy',
      'sell',
      'income',
      'expense',
      'adjustment',
      'cash_movement',
    ]);
  });

  it('marks only the transfer types as two-legged', () => {
    const twoLegged = ENTRY_TYPE_KEYS.filter(isTwoLegged);
    expect(twoLegged).toEqual(['commitment_transfer', 'unit_transfer']);
  });

  it('gives all four inflow types cash_delta > 0, read from the holder', () => {
    // Distribution, redemption, sell and income all put money into the
    // holder's pocket — which is what lets DPI and IRR be summed from cash_delta.
    for (const type of ['distribution', 'redemption', 'sell', 'income'] as FlEntryType[]) {
      expect(ENTRY_TYPES[type].cash).toBe('positive');
      expect(ENTRY_TYPES[type].direction).toBe('in');
    }
  });

  it('gives the outflow types a negative cash rule', () => {
    for (const type of ['paid_in', 'buy', 'expense'] as FlEntryType[]) {
      expect(ENTRY_TYPES[type].cash).toBe('negative');
      expect(ENTRY_TYPES[type].direction).toBe('out');
    }
  });

  it('forbids cash on the two types that never move money', () => {
    expect(ENTRY_TYPES.commitment.cash).toBe('zero');
    expect(ENTRY_TYPES.adjustment.cash).toBe('zero');
  });

  it('restricts fund-only and asset-only types to their position kind', () => {
    expect(allowsPositionKind('commitment', 'fund')).toBe(true);
    expect(allowsPositionKind('commitment', 'asset')).toBe(false);
    expect(allowsPositionKind('buy', 'asset')).toBe(true);
    expect(allowsPositionKind('buy', 'fund')).toBe(false);
    expect(allowsPositionKind('income', 'fund')).toBe(true);
    expect(allowsPositionKind('income', 'asset')).toBe(true);
    expect(allowsPositionKind('cash_movement', 'asset')).toBe(true);
    expect(allowsPositionKind('cash_movement', 'fund')).toBe(false);
  });

  it('defines delta rules and direction for cash_movement', () => {
    expect(ENTRY_TYPES.cash_movement.on).toBe('asset');
    expect(ENTRY_TYPES.cash_movement.commitment).toBe('zero');
    expect(ENTRY_TYPES.cash_movement.quantity).toBe('zero');
    expect(ENTRY_TYPES.cash_movement.cash).toBe('nonzero');
    expect(ENTRY_TYPES.cash_movement.direction).toBe('move');
  });
});

describe('entryTypeSpec', () => {
  it('returns undefined for a value that is not an entry type', () => {
    expect(entryTypeSpec('not_a_type')).toBeUndefined();
  });

  it('falls back to the raw value when labelling an unknown type', () => {
    expect(entryTypeLabel('not_a_type')).toBe('not_a_type');
    expect(entryTypeShortLabel('not_a_type')).toBe('not_a_type');
  });

  it('uses the short label where one exists and the full label otherwise', () => {
    expect(entryTypeShortLabel('commitment_transfer')).toBe('Commit. transfer');
    expect(entryTypeShortLabel('buy')).toBe('Buy');
  });
});

describe('ruleGlyph', () => {
  it('renders each rule as its matrix symbol', () => {
    expect(ruleGlyph('zero')).toBe('0');
    expect(ruleGlyph('positive')).toBe('+');
    expect(ruleGlyph('non_negative')).toBe('+');
    expect(ruleGlyph('negative')).toBe('−');
    expect(ruleGlyph('non_positive')).toBe('−');
    expect(ruleGlyph('nonzero')).toBe('±');
    expect(ruleGlyph('free')).toBe('±');
  });

  it('flags only the fixed-zero rule as never editable', () => {
    expect(ruleIsFixedZero('zero')).toBe(true);
    expect(ruleIsFixedZero('free')).toBe(false);
    expect(ruleIsFixedZero('nonzero')).toBe(false);
  });
});

describe('satisfiesRule', () => {
  it('accepts zero only where the rule allows it', () => {
    expect(satisfiesRule('zero', 0)).toBe(true);
    expect(satisfiesRule('nonzero', 0)).toBe(false);
    expect(satisfiesRule('positive', 0)).toBe(false);
    expect(satisfiesRule('non_negative', 0)).toBe(true);
    expect(satisfiesRule('non_positive', 0)).toBe(true);
    expect(satisfiesRule('free', 0)).toBe(true);
  });

  it('checks the sign for the directional rules', () => {
    expect(satisfiesRule('positive', 5)).toBe(true);
    expect(satisfiesRule('positive', -5)).toBe(false);
    expect(satisfiesRule('negative', -5)).toBe(true);
    expect(satisfiesRule('negative', 5)).toBe(false);
    expect(satisfiesRule('non_negative', -1)).toBe(false);
    expect(satisfiesRule('non_positive', 1)).toBe(false);
  });

  it('mirrors directional rules when isReversal is true', () => {
    expect(satisfiesRule('positive', -5, true)).toBe(true);
    expect(satisfiesRule('positive', 5, true)).toBe(false);
    expect(satisfiesRule('negative', 5, true)).toBe(true);
    expect(satisfiesRule('negative', -5, true)).toBe(false);
    expect(satisfiesRule('non_negative', -1, true)).toBe(true);
    expect(satisfiesRule('non_negative', 1, true)).toBe(false);
    expect(satisfiesRule('non_positive', 1, true)).toBe(true);
    expect(satisfiesRule('non_positive', -1, true)).toBe(false);
    expect(satisfiesRule('zero', 0, true)).toBe(true);
    expect(satisfiesRule('nonzero', 5, true)).toBe(true);
    expect(satisfiesRule('free', -100, true)).toBe(true);
  });
});

describe('mirrorRuleForReversal', () => {
  it('inverts positive/negative and non_negative/non_positive while keeping neutral rules', () => {
    expect(mirrorRuleForReversal('positive')).toBe('negative');
    expect(mirrorRuleForReversal('negative')).toBe('positive');
    expect(mirrorRuleForReversal('non_negative')).toBe('non_positive');
    expect(mirrorRuleForReversal('non_positive')).toBe('non_negative');
    expect(mirrorRuleForReversal('zero')).toBe('zero');
    expect(mirrorRuleForReversal('nonzero')).toBe('nonzero');
    expect(mirrorRuleForReversal('free')).toBe('free');
  });
});

describe('signedForRule', () => {
  it('applies the type sign to a magnitude the user typed', () => {
    // The form only ever asks "how much"; the signs come from the type.
    expect(signedForRule('negative', 1_500_000)).toBe(-1_500_000);
    expect(signedForRule('non_positive', 1_500_000)).toBe(-1_500_000);
    expect(signedForRule('positive', 1_500_000)).toBe(1_500_000);
    expect(signedForRule('non_negative', 1_500_000)).toBe(1_500_000);
    expect(signedForRule('nonzero', 1_500_000)).toBe(1_500_000);
  });

  it('ignores a sign typed into the box rather than trusting it', () => {
    expect(signedForRule('negative', -42)).toBe(-42);
    expect(signedForRule('positive', -42)).toBe(42);
  });

  it('returns zero for a column the type may never touch', () => {
    expect(signedForRule('zero', 999)).toBe(0);
  });
});
