import { describe, expect, it } from 'vitest';
import { paidInAdjustmentDelta } from './paidInAdjustment';

describe('paid-in adjustment classification', () => {
  it('includes reductions and reversals only for the reserved adjustment subtype', () => {
    expect(paidInAdjustmentDelta({ entry_type: 'adjustment', sub_type: 'paid_in_writeoff', valuation_delta: '-914781.37' })).toBe('-914781.37');
    expect(paidInAdjustmentDelta({ entry_type: 'adjustment', sub_type: 'paid_in_writeoff', valuation_delta: '914781.37' })).toBe('914781.37');
    expect(paidInAdjustmentDelta({ entry_type: 'adjustment', sub_type: 'profit_loss_writeoff', valuation_delta: '-914781.37' })).toBe('0');
    expect(paidInAdjustmentDelta({ entry_type: 'adjustment', sub_type: null, valuation_delta: '-914781.37' })).toBe('0');
    expect(paidInAdjustmentDelta({ entry_type: 'buy', sub_type: 'paid_in_writeoff', valuation_delta: '-914781.37' })).toBe('0');
  });
});
