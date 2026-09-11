import { describe, expect, it } from 'vitest';

import {
  ADJUSTMENT_AMOUNT_LABELS,
  ADJUSTMENT_SUB_TYPE_LABELS,
  adjustmentDirectionOptions,
  adjustmentSubTypesFor,
  resolveAdjustmentSubType,
} from './adjustmentSubTypes';

describe('adjustmentSubTypesFor', () => {
  it('offers a paid-in write-off only on a stake in a fund', () => {
    expect(adjustmentSubTypesFor('fund')).toEqual([
      'paid_in_writeoff',
      'valuation_restatement',
    ]);
  });

  it('offers only a restatement on an asset, which has no paid-in capital', () => {
    expect(adjustmentSubTypesFor('asset')).toEqual(['valuation_restatement']);
  });

  it('treats a position it cannot resolve as not a fund stake', () => {
    expect(adjustmentSubTypesFor('unknown')).toEqual(['valuation_restatement']);
  });

  it('leads with the write-off before a position is chosen, since none can post', () => {
    expect(adjustmentSubTypesFor(null)).toEqual([
      'paid_in_writeoff',
      'valuation_restatement',
    ]);
    expect(adjustmentSubTypesFor(undefined)[0]).toBe('paid_in_writeoff');
  });
});

describe('resolveAdjustmentSubType', () => {
  it('keeps the reviewer choice when the position allows it', () => {
    expect(resolveAdjustmentSubType('paid_in_writeoff', 'fund')).toBe('paid_in_writeoff');
    expect(resolveAdjustmentSubType('valuation_restatement', 'fund')).toBe(
      'valuation_restatement',
    );
  });

  it('coerces a write-off the position cannot take', () => {
    expect(resolveAdjustmentSubType('paid_in_writeoff', 'asset')).toBe('valuation_restatement');
  });

  it('falls back to the first allowed option for free text or nothing', () => {
    expect(resolveAdjustmentSubType('follow_on', 'fund')).toBe('paid_in_writeoff');
    expect(resolveAdjustmentSubType('', 'fund')).toBe('paid_in_writeoff');
    expect(resolveAdjustmentSubType(null, 'fund')).toBe('paid_in_writeoff');
    expect(resolveAdjustmentSubType(undefined, 'asset')).toBe('valuation_restatement');
    expect(resolveAdjustmentSubType(undefined, null)).toBe('paid_in_writeoff');
  });

  it('ignores surrounding whitespace rather than treating it as free text', () => {
    expect(resolveAdjustmentSubType('  valuation_restatement  ', 'fund')).toBe(
      'valuation_restatement',
    );
  });
});

describe('adjustmentDirectionOptions', () => {
  it('names paid-in capital for a write-off', () => {
    expect(adjustmentDirectionOptions('paid_in_writeoff').map((o) => o.label)).toEqual([
      'Increase paid-in capital',
      'Decrease paid-in capital',
    ]);
  });

  it('names carrying value for a restatement', () => {
    expect(adjustmentDirectionOptions('valuation_restatement').map((o) => o.label)).toEqual([
      'Increase carrying value',
      'Decrease carrying value',
    ]);
  });

  it('signs both kinds with the same decrease flag', () => {
    for (const subType of ['paid_in_writeoff', 'valuation_restatement'] as const) {
      expect(adjustmentDirectionOptions(subType).map((o) => o.value)).toEqual([
        'increase',
        'decrease',
      ]);
    }
  });
});

describe('adjustment labels', () => {
  it('covers every sub-type, so the form can never render a blank', () => {
    for (const subType of ['paid_in_writeoff', 'valuation_restatement'] as const) {
      expect(ADJUSTMENT_SUB_TYPE_LABELS[subType]).toBeTruthy();
      expect(ADJUSTMENT_AMOUNT_LABELS[subType]).toBeTruthy();
    }
  });
});
