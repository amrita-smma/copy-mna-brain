import { describe, expect, it } from 'vitest';
import {
  applyCommas,
  formatCompact,
  formatGrouped,
  formatPercentage,
  groupNumericText,
  parseCurrencyInput,
  regroupNumericInput,
  stripCommas,
} from './numberFormat';

describe('applyCommas', () => {
  it('groups the integer part and leaves the rest alone', () => {
    expect(applyCommas('1000000')).toBe('1,000,000');
    expect(applyCommas('1234.5678')).toBe('1,234.5678');
    expect(applyCommas('-43780000.00')).toBe('-43,780,000.00');
  });

  it('keeps a decimal point the user is still typing behind', () => {
    expect(applyCommas('1000.')).toBe('1,000.');
  });

  it('passes an empty string through', () => {
    expect(applyCommas('')).toBe('');
  });
});

describe('stripCommas', () => {
  it('removes every separator', () => {
    expect(stripCommas('1,000,000.50')).toBe('1000000.50');
    expect(stripCommas('1000')).toBe('1000');
  });
});

describe('formatGrouped', () => {
  it('groups a number', () => {
    expect(formatGrouped(2000)).toBe('2,000');
    expect(formatGrouped(1234.5)).toBe('1,234.5');
    expect(formatGrouped(-1000000)).toBe('-1,000,000');
  });

  it('returns an empty string for a non-finite value', () => {
    expect(formatGrouped(Number.NaN)).toBe('');
  });
});

describe('formatCompact', () => {
  it('buckets by magnitude', () => {
    expect(formatCompact(2_000_000)).toBe('2M');
    expect(formatCompact(2500)).toBe('2.5k');
    expect(formatCompact(1.5e9)).toBe('1.5B');
    expect(formatCompact(500)).toBe('500');
    expect(formatCompact(-2_000_000)).toBe('-2M');
  });
});

describe('formatPercentage', () => {
  it('rounds percentages to exactly two decimal places', () => {
    expect(formatPercentage(1.5682790039999999)).toBe('1.57%');
    expect(formatPercentage(2)).toBe('2.00%');
  });

  it('returns an empty string for a non-finite value', () => {
    expect(formatPercentage(Number.NaN)).toBe('');
  });
});

describe('parseCurrencyInput', () => {
  it('reads grouped and suffixed input back to a number', () => {
    expect(parseCurrencyInput('1,500,000')).toBe(1_500_000);
    expect(parseCurrencyInput('1.5m')).toBe(1_500_000);
    expect(parseCurrencyInput('2K')).toBe(2000);
    expect(parseCurrencyInput('-3.25')).toBe(-3.25);
  });

  it('returns null for blank or unparseable input', () => {
    expect(parseCurrencyInput('')).toBeNull();
    expect(parseCurrencyInput('  ')).toBeNull();
    expect(parseCurrencyInput('abc')).toBeNull();
  });
});

describe('regroupNumericInput', () => {
  it('groups what the user typed', () => {
    expect(regroupNumericInput('1000000', 7).text).toBe('1,000,000');
  });

  it('keeps the caret behind the digit just typed, past any new separator', () => {
    // "1,00|0" + "5" typed at the caret -> "10050" -> "10,050", caret after the 5.
    const { text, caret } = regroupNumericInput('1,0050', 5);
    expect(text).toBe('10,050');
    expect(caret).toBe(5);
    expect(text.slice(0, caret)).toBe('10,05');
  });

  it('leaves the caret at the start of the field alone', () => {
    expect(regroupNumericInput('1,000', 0).caret).toBe(0);
  });

  it('drops a pasted currency symbol, which cannot change the value', () => {
    const { text, value, caret } = regroupNumericInput('$1000', 5);
    expect(text).toBe('1,000');
    expect(value).toBe('1000');
    // Dropping the "$" must not push the caret a place right.
    expect(caret).toBe(5);
  });

  it('returns text it cannot read as a number exactly as typed', () => {
    // Deleting the "e" would turn 10,000,000 into 17 — silently, and after
    // `toDecimalString` would have expanded it correctly.
    expect(regroupNumericInput('1e7', 3)).toEqual({ text: '1e7', value: '1e7', caret: 3 });
    expect(regroupNumericInput('1.5e6', 5).value).toBe('1.5e6');
    expect(regroupNumericInput('1,0a0b0', 6).value).toBe('1,0a0b0');
  });

  it('keeps a k/m/b multiplier where the field allows one, and refuses to strip it where it does not', () => {
    // Stripping the "m" would post 1.5 for an intended 1,500,000.
    expect(regroupNumericInput('1.5m', 4).value).toBe('1.5m');
    expect(regroupNumericInput('1.5m', 4, { allowSuffix: true }).text).toBe('1.5m');
  });

  it('keeps a decimal point and a leading minus', () => {
    expect(regroupNumericInput('-43780000.00', 12).text).toBe('-43,780,000.00');
  });
});

describe('groupNumericText', () => {
  it('groups a number it understands', () => {
    expect(groupNumericText('1000000')).toBe('1,000,000');
    expect(groupNumericText('1,000,000')).toBe('1,000,000');
    expect(groupNumericText('')).toBe('');
  });

  it('leaves anything else alone', () => {
    expect(groupNumericText('1e7')).toBe('1e7');
    expect(groupNumericText('1.5m')).toBe('1.5m');
    expect(groupNumericText('1.5m', { allowSuffix: true })).toBe('1.5m');
    expect(groupNumericText('1234m', { allowSuffix: true })).toBe('1,234m');
  });
});
