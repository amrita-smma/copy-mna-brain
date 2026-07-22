import { describe, expect, it } from 'vitest';
import {
  CURRENCIES,
  CURRENCY_SYMBOL,
  DEFAULT_CURRENCY,
  formatMoneyMn,
  normalizeCurrency,
} from './currency';

describe('currency constants', () => {
  it('exposes the three supported currencies with symbols', () => {
    expect(CURRENCIES).toEqual(['USD', 'IDR', 'CNY']);
    expect(CURRENCY_SYMBOL).toEqual({ USD: '$', IDR: 'Rp', CNY: 'RMB ' });
    expect(DEFAULT_CURRENCY).toBe('USD');
  });
});

describe('normalizeCurrency', () => {
  it('recognizes each supported code regardless of casing', () => {
    expect(normalizeCurrency('USD')).toBe('USD');
    expect(normalizeCurrency('idr')).toBe('IDR');
    expect(normalizeCurrency('Cny')).toBe('CNY');
  });

  it('falls back to USD for null, undefined, or unknown values', () => {
    expect(normalizeCurrency(null)).toBe('USD');
    expect(normalizeCurrency(undefined)).toBe('USD');
    expect(normalizeCurrency('EUR')).toBe('USD');
    expect(normalizeCurrency('')).toBe('USD');
  });
});

describe('formatMoneyMn', () => {
  it('returns a dash for null/undefined', () => {
    expect(formatMoneyMn(null, 'USD')).toBe('-');
    expect(formatMoneyMn(undefined, 'IDR')).toBe('-');
  });

  it('formats millions with 2 decimals and the currency symbol', () => {
    expect(formatMoneyMn(312.5, 'USD')).toBe('$312.50M');
    expect(formatMoneyMn(312.5, 'IDR')).toBe('Rp312.50M');
    expect(formatMoneyMn(312.5, 'CNY')).toBe('RMB 312.50M');
  });

  it('switches to billions at the 1000-million threshold', () => {
    expect(formatMoneyMn(999.99, 'USD')).toBe('$999.99M');
    expect(formatMoneyMn(1000, 'USD')).toBe('$1.00B');
    expect(formatMoneyMn(2500, 'IDR')).toBe('Rp2.50B');
  });

  it('uses the ISO code prefix when codePrefix is set', () => {
    expect(formatMoneyMn(312.5, 'USD', { codePrefix: true })).toBe('USD 312.50M');
    expect(formatMoneyMn(4900, 'IDR', { codePrefix: true })).toBe('IDR 4.90B');
  });

  it('handles negatives via the absolute-value threshold', () => {
    expect(formatMoneyMn(-1500, 'USD')).toBe('$-1.50B');
  });
});
