import { describe, expect, it } from 'vitest';
import {
  flAbs,
  flAdd,
  flCmp,
  flDiv,
  flEq,
  flGt,
  flGte,
  flIsNegative,
  flIsPositive,
  flIsZero,
  flLt,
  flLte,
  flMul,
  flNeg,
  flNeq,
  flSub,
  flSum,
  formatScaledBigInt,
  parseToScaledBigInt,
  safeExactDecimalString,
  toDecimalString,
} from './flDecimal';

describe('flDecimal', () => {
  describe('parseToScaledBigInt & formatScaledBigInt', () => {
    it('parses integers and zero', () => {
      expect(parseToScaledBigInt('0')).toBe(BigInt(0));
      expect(parseToScaledBigInt('-0')).toBe(BigInt(0));
      expect(parseToScaledBigInt('100')).toBe(BigInt('100000000000000000000'));
      expect(parseToScaledBigInt('-100')).toBe(BigInt('-100000000000000000000'));
    });

    it('parses decimals accurately', () => {
      expect(parseToScaledBigInt('123.456')).toBe(BigInt('123456000000000000000'));
      expect(parseToScaledBigInt('-0.00000001')).toBe(BigInt('-10000000000'));
      expect(parseToScaledBigInt('+42.5')).toBe(BigInt('42500000000000000000'));
    });

    it('parses scientific notation', () => {
      expect(parseToScaledBigInt('1e-5')).toBe(BigInt('10000000000000'));
      expect(parseToScaledBigInt('-2.5e3')).toBe(BigInt('-2500000000000000000000'));
    });

    it('formats to scale 8 correctly', () => {
      expect(formatScaledBigInt(BigInt(0), 8)).toBe('0.00000000');
      expect(formatScaledBigInt(BigInt('100000000000000000000'), 8)).toBe('100.00000000');
      expect(formatScaledBigInt(BigInt('-50123456780000000000'), 8)).toBe('-50.12345678');
    });

    it('formats to scale 0 and custom scales', () => {
      expect(formatScaledBigInt(BigInt('100000000000000000000'), 0)).toBe('100');
      expect(formatScaledBigInt(BigInt('123456789012000000'), 12)).toBe('0.123456789012');
    });

    it('toDecimalString normalizes numbers', () => {
      expect(toDecimalString('100')).toBe('100.00000000');
      expect(toDecimalString('0.5', 2)).toBe('0.50');
      expect(toDecimalString('-42.123456789', 8)).toBe('-42.12345679');
    });

    it('strictly rejects non-string inputs at runtime', () => {
      expect(() => parseToScaledBigInt(100 as any)).toThrow(TypeError);
      expect(() => parseToScaledBigInt(null as any)).toThrow(TypeError);
      expect(() => parseToScaledBigInt(undefined as any)).toThrow(TypeError);
      expect(() => parseToScaledBigInt({} as any)).toThrow(TypeError);
      expect(() => flAdd(100 as any, '200')).toThrow(TypeError);
    });
  });

  describe('Arithmetic operations without floating-point error', () => {
    it('flAdd adds exactly without 0.1 + 0.2 floating point error', () => {
      expect(flAdd('0.1', '0.2')).toBe('0.30000000');
      expect(flAdd('100.5', '200.75')).toBe('301.25000000');
      expect(flAdd('-50', '30')).toBe('-20.00000000');
    });

    it('flSub subtracts exactly', () => {
      expect(flSub('100', '40')).toBe('60.00000000');
      expect(flSub('10.5', '20.5')).toBe('-10.00000000');
      expect(flSub('0.3', '0.1')).toBe('0.20000000');
    });

    it('flMul multiplies exactly', () => {
      expect(flMul('10.5', '2')).toBe('21.00000000');
      expect(flMul('1000', '0.05')).toBe('50.00000000');
      expect(flMul('-5', '10')).toBe('-50.00000000');
    });

    it('flDiv divides exactly and handles division by zero', () => {
      expect(flDiv('100', '4')).toBe('25.00000000');
      expect(flDiv('100', '3')).toBe('33.33333333');
      expect(() => flDiv('100', '0')).toThrow(RangeError);
    });

    it('flNeg and flAbs negate and compute magnitude', () => {
      expect(flNeg('50.5')).toBe('-50.50000000');
      expect(flNeg('-50.5')).toBe('50.50000000');
      expect(flNeg('0')).toBe('0.00000000');
      expect(flAbs('-123.456')).toBe('123.45600000');
      expect(flAbs('123.456')).toBe('123.45600000');
    });

    it('flSum sums arrays of numbers', () => {
      expect(flSum(['10', '20', '30.5'])).toBe('60.50000000');
      expect(flSum([])).toBe('0.00000000');
      expect(flSum(['-100', '50', '50'])).toBe('0.00000000');
    });
  });

  describe('Comparison operations', () => {
    it('flCmp compares correctly', () => {
      expect(flCmp('100', '50')).toBe(1);
      expect(flCmp('50', '100')).toBe(-1);
      expect(flCmp('100.00000000', '100')).toBe(0);
      expect(flCmp('-10', '-20')).toBe(1);
    });

    it('flEq and flNeq', () => {
      expect(flEq('100', '100.00000000')).toBe(true);
      expect(flEq('0', '-0')).toBe(true);
      expect(flEq('100', '101')).toBe(false);
      expect(flNeq('100', '101')).toBe(true);
    });

    it('flGt, flGte, flLt, flLte', () => {
      expect(flGt('100', '99.99')).toBe(true);
      expect(flGt('100', '100')).toBe(false);
      expect(flGte('100', '100')).toBe(true);
      expect(flLt('50', '60')).toBe(true);
      expect(flLte('50', '50')).toBe(true);
      expect(flLte('51', '50')).toBe(false);
    });

    it('flIsZero, flIsPositive, flIsNegative', () => {
      expect(flIsZero('0')).toBe(true);
      expect(flIsZero('0.00000000')).toBe(true);
      expect(flIsZero('-0')).toBe(true);
      expect(flIsZero('0.00000001')).toBe(false);

      expect(flIsPositive('1')).toBe(true);
      expect(flIsPositive('0')).toBe(false);
      expect(flIsPositive('-1')).toBe(false);

      expect(flIsNegative('-1')).toBe(true);
      expect(flIsNegative('0')).toBe(false);
      expect(flIsNegative('1')).toBe(false);
    });
  });
  describe('safeExactDecimalString', () => {
    it('returns null for null, undefined, and blank strings', () => {
      expect(safeExactDecimalString(null)).toBeNull();
      expect(safeExactDecimalString(undefined)).toBeNull();
      expect(safeExactDecimalString('')).toBeNull();
      expect(safeExactDecimalString('   ')).toBeNull();
    });

    it('converts present values with the exact converter', () => {
      expect(safeExactDecimalString(100)).toBe('100.00000000');
      expect(safeExactDecimalString('50.5')).toBe('50.50000000');
      expect(safeExactDecimalString(0)).toBe('0.00000000');
      expect(safeExactDecimalString(-25)).toBe('-25.00000000');
    });

    it('honours a caller-supplied scale', () => {
      expect(safeExactDecimalString('1.239', 2)).toBe('1.24');
    });

    it('still throws for present but non-finite values', () => {
      expect(() => safeExactDecimalString(NaN)).toThrow();
      expect(() => safeExactDecimalString(Infinity)).toThrow();
    });
  });
});
