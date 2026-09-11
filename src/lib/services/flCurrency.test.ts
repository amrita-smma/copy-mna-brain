import { describe, expect, it } from 'vitest';
import { isValidCurrency, validateCurrency } from './flCurrency';
import { InvalidCurrencyError } from './flErrors';

describe('flCurrency', () => {
  it('accepts valid ISO 4217 currency codes', () => {
    expect(validateCurrency('USD')).toBe('USD');
    expect(validateCurrency('usd')).toBe('USD');
    expect(validateCurrency('EUR')).toBe('EUR');
    expect(validateCurrency('CNY')).toBe('CNY');
    expect(validateCurrency('JPY')).toBe('JPY');
    expect(validateCurrency('GBP')).toBe('GBP');
    expect(validateCurrency('SGD')).toBe('SGD');
    expect(validateCurrency('HKD')).toBe('HKD');
  });

  it('rejects invalid or missing currency codes', () => {
    expect(() => validateCurrency('')).toThrow(InvalidCurrencyError);
    expect(() => validateCurrency(null)).toThrow(InvalidCurrencyError);
    expect(() => validateCurrency(undefined)).toThrow(InvalidCurrencyError);
    expect(() => validateCurrency('XYZ99')).toThrow(InvalidCurrencyError);
    expect(() => validateCurrency('US')).toThrow(InvalidCurrencyError);
    expect(() => validateCurrency('USDD')).toThrow(InvalidCurrencyError);
    expect(() => validateCurrency('INVALID')).toThrow(InvalidCurrencyError);
  });

  it('isValidCurrency returns boolean without throwing', () => {
    expect(isValidCurrency('USD')).toBe(true);
    expect(isValidCurrency('cny')).toBe(true);
    expect(isValidCurrency('INVALID')).toBe(false);
    expect(isValidCurrency('')).toBe(false);
    expect(isValidCurrency(null)).toBe(false);
  });
});
