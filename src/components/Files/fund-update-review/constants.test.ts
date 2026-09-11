import { describe, it, expect } from 'vitest';

import { formatMoney, formatMoneyExact, formatPrice } from './constants';

describe('formatMoney', () => {
  it('prefixes CNY amounts with RMB rather than the yen sign', () => {
    expect(formatMoney(-4_000_000, 'CNY')).toBe('−RMB 4M');
    expect(formatMoney(-4_000_000, 'CNY')).not.toContain('¥');
  });

  it('prefixes IDR amounts with Rp', () => {
    expect(formatMoney(1_500_000, 'IDR')).toBe('+Rp1.50M');
  });

  it('falls back to the dollar sign for USD and unknown codes', () => {
    expect(formatMoney(1_500_000, 'USD')).toBe('+$1.50M');
    expect(formatMoney(1_500_000, 'ZZZ')).toBe('+$1.50M');
  });
});

describe('formatPrice', () => {
  it('prefixes CNY prices with RMB', () => {
    expect(formatPrice(1234.5, 'CNY')).toBe('RMB 1234.50');
  });
});

describe('formatMoneyExact', () => {
  it('renders the full figure rather than a compact M/K abbreviation', () => {
    expect(formatMoneyExact(1_000_000, 'CNY')).toBe('RMB 1,000,000.00');
    expect(formatMoneyExact(100_000, 'CNY')).toBe('RMB 100,000.00');
  });

  it('renders zero as a figure, not as a dash', () => {
    expect(formatMoneyExact(0, 'CNY')).toBe('RMB 0.00');
  });

  it('renders a dash only for a missing or non-finite amount', () => {
    expect(formatMoneyExact(null, 'CNY')).toBe('—');
    expect(formatMoneyExact(undefined, 'CNY')).toBe('—');
    expect(formatMoneyExact(Number.NaN, 'CNY')).toBe('—');
  });

  it('is unsigned by default so a target balance carries no implied direction', () => {
    expect(formatMoneyExact(100_000, 'CNY')).toBe('RMB 100,000.00');
    expect(formatMoneyExact(-100_000, 'CNY')).toBe('RMB 100,000.00');
  });

  it('shows an explicit sign for both directions when signed', () => {
    expect(formatMoneyExact(-100_000, 'CNY', { signed: true })).toBe('−RMB 100,000.00');
    expect(formatMoneyExact(100_000, 'CNY', { signed: true })).toBe('+RMB 100,000.00');
  });

  it('uses each currency symbol and falls back to the dollar sign', () => {
    expect(formatMoneyExact(2_500, 'IDR')).toBe('Rp2,500.00');
    expect(formatMoneyExact(2_500, 'USD')).toBe('$2,500.00');
    expect(formatMoneyExact(2_500, 'ZZZ')).toBe('$2,500.00');
  });
});
