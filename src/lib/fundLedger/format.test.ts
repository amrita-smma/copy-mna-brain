import { describe, expect, it } from 'vitest';
import {
  EMPTY_CELL,
  addDays,
  derivePricePerUnit,
  distinctEnglishName,
  formatDate,
  formatDateInput,
  formatDateNumeric,
  formatDateShort,
  formatExact,
  formatExactAuto,
  formatMoney,
  formatMoneyAbs,
  formatPrice,
  formatQuantity,
  formatQuantityAbs,
  parseDateInput,
  signOf,
  toIsoDate,
  toNumber,
} from './format';

describe('toNumber', () => {
  it('parses decimal strings and passes numbers through', () => {
    expect(toNumber('-43780000.00000000')).toBe(-43780000);
    expect(toNumber(1234.5)).toBe(1234.5);
  });

  it('treats missing and unparseable values as zero rather than NaN', () => {
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber('')).toBe(0);
    expect(toNumber('not a number')).toBe(0);
    expect(toNumber(Number.NaN)).toBe(0);
    expect(toNumber(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('formatExact', () => {
  it('writes the full figure with thousands separators', () => {
    expect(formatExact('-43780000')).toBe('−43,780,000.00');
    expect(formatExact('1234.5')).toBe('1,234.50');
    expect(formatExact('0')).toBe('0.00');
  });

  it('keeps every digit past the double-precision limit', () => {
    // 2^53 + 1 — a float would round this down to ...992.
    expect(formatExact('9007199254740993', 0)).toBe('9,007,199,254,740,993');
  });

  it('falls back to a zero rather than throwing on a malformed amount', () => {
    expect(formatExact('not a number')).toBe('0.00');
    expect(formatExact(null)).toBe('0.00');
  });
});

describe('formatExactAuto', () => {
  it('keeps fractional units that a two-place format would round away', () => {
    // A 0.001-unit movement must not render as 0.00.
    expect(formatExactAuto('0.001')).toBe('0.001');
    expect(formatExactAuto('0.00000003')).toBe('0.00000003');
  });

  it('pads a whole number back out so it lines up with the money columns', () => {
    expect(formatExactAuto('2210000')).toBe('2,210,000.00');
    expect(formatExactAuto('-330000')).toBe('−330,000.00');
    expect(formatExactAuto('0')).toBe('0.00');
  });

  it('honours a different minimum scale', () => {
    expect(formatExactAuto('2210000', 0)).toBe('2,210,000');
    expect(formatExactAuto('0.5', 0)).toBe('0.5');
  });

  it('falls back to zero rather than throwing on a malformed amount', () => {
    expect(formatExactAuto('not a number')).toBe('0.00');
    expect(formatExactAuto(null)).toBe('0.00');
  });
});

describe('formatMoney', () => {
  it('signs and compacts to a K/M suffix', () => {
    expect(formatMoney('-43780000')).toBe('−$43.78M');
    expect(formatMoney('3200000')).toBe('+$3.20M');
    expect(formatMoney('25000')).toBe('+$25K');
    expect(formatMoney('980')).toBe('+$980');
  });

  it('drops a bare ".00" but keeps a meaningful second decimal', () => {
    expect(formatMoney('2000000')).toBe('+$2M');
    expect(formatMoney('2050000')).toBe('+$2.05M');
  });

  it('shows a dash for zero, so an untouched column never reads as a posted zero', () => {
    expect(formatMoney('0')).toBe(EMPTY_CELL);
    expect(formatMoney(null)).toBe(EMPTY_CELL);
  });

  it('drops the sign for the unsigned form', () => {
    expect(formatMoneyAbs('-43780000')).toBe('$43.78M');
    expect(formatMoneyAbs('0')).toBe('$0');
  });
});

describe('formatQuantity', () => {
  it('signs unit counts and groups them', () => {
    expect(formatQuantity('9500000')).toBe('+9,500,000');
    expect(formatQuantity('-330000')).toBe('−330,000');
    expect(formatQuantity('0')).toBe(EMPTY_CELL);
  });

  it('drops the sign for the unsigned form', () => {
    expect(formatQuantityAbs('-330000')).toBe('330,000');
  });
});

describe('formatPrice', () => {
  it('keeps four decimals below $100 and two above', () => {
    expect(formatPrice('4.608')).toBe('$4.6080');
    expect(formatPrice('1')).toBe('$1.0000');
    expect(formatPrice('120.5')).toBe('$120.50');
  });

  it('supports the caller currency symbol', () => {
    expect(formatPrice('4.608', '¥')).toBe('¥4.6080');
  });

  it('returns null when there is no price, so the cell can say so', () => {
    expect(formatPrice(null)).toBeNull();
    expect(formatPrice('')).toBeNull();
    expect(formatPrice('0')).toBeNull();
  });
});

describe('derivePricePerUnit', () => {
  it('prefers the price the row was actually recorded at', () => {
    expect(derivePricePerUnit('4.608', '9500000', '-43780000')).toBe(4.608);
  });

  it('derives cash ÷ units when the source recorded no price', () => {
    expect(derivePricePerUnit(null, '2000000', '-6000000')).toBe(3);
  });

  it('returns null when neither exists rather than implying a free acquisition', () => {
    expect(derivePricePerUnit(null, '0', '-6000000')).toBeNull();
    expect(derivePricePerUnit(null, '2000000', '0')).toBeNull();
    expect(derivePricePerUnit('0', '0', '0')).toBeNull();
  });
});

describe('signOf', () => {
  it('classifies a value for colouring', () => {
    expect(signOf('1')).toBe('positive');
    expect(signOf('-1')).toBe('negative');
    expect(signOf('0')).toBe('zero');
    expect(signOf(null)).toBe('zero');
  });
});

describe('date formatting', () => {
  it('renders an ISO date in the three widths the page uses', () => {
    expect(formatDate('2018-01-15')).toBe('15 Jan 2018');
    expect(formatDateShort('2018-01-15')).toBe('15 Jan 18');
    expect(formatDateNumeric('2018-01-15')).toBe('15/01/18');
    expect(formatDateInput('2018-01-15')).toBe('15/01/2018');
  });

  it('reads an ISO date as local midnight, never shifted by the timezone', () => {
    // A UTC-parsed '2018-01-15' renders as the 14th anywhere west of Greenwich.
    expect(formatDate('2018-01-15')).toContain('15');
    expect(formatDateNumeric('2018-01-15').startsWith('15/')).toBe(true);
  });

  it('shows a dash for a missing date and echoes anything unparseable', () => {
    expect(formatDate(null)).toBe(EMPTY_CELL);
    expect(formatDateNumeric('')).toBe(EMPTY_CELL);
    expect(formatDate('nonsense')).toBe('nonsense');
    expect(formatDateInput(null)).toBe('');
  });
});

describe('parseDateInput', () => {
  it('accepts dd/mm/yyyy', () => {
    expect(parseDateInput('15/01/2018')).toBe('2018-01-15');
    expect(parseDateInput(' 1/2/2026 ')).toBe('2026-02-01');
  });

  it('rejects a day that does not exist rather than rolling into the next month', () => {
    expect(parseDateInput('31/02/2026')).toBeNull();
    expect(parseDateInput('32/01/2026')).toBeNull();
  });

  it('rejects anything that is not dd/mm/yyyy', () => {
    expect(parseDateInput('2026-01-15')).toBeNull();
    expect(parseDateInput('')).toBeNull();
    expect(parseDateInput('15 Jan 2018')).toBeNull();
  });
});

describe('addDays', () => {
  it('shifts a date and crosses month and year boundaries', () => {
    expect(addDays('2026-08-31', -30)).toBe('2026-08-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('returns the input unchanged when it is not a date', () => {
    expect(addDays('nonsense', -7)).toBe('nonsense');
  });
});

describe('toIsoDate', () => {
  it('formats a local date without a UTC shift', () => {
    expect(toIsoDate(new Date(2026, 7, 31))).toBe('2026-08-31');
    expect(toIsoDate(new Date(2026, 0, 1))).toBe('2026-01-01');
  });
});

describe('distinctEnglishName', () => {
  it('returns the English name when it differs from the recorded one', () => {
    expect(distinctEnglishName('高亚投资有限公司', 'Globe Asia Investment')).toBe(
      'Globe Asia Investment',
    );
  });

  it('returns undefined when there is nothing to add', () => {
    expect(distinctEnglishName('Acme', null)).toBeUndefined();
    expect(distinctEnglishName('Acme', undefined)).toBeUndefined();
    expect(distinctEnglishName('Acme', '   ')).toBeUndefined();
  });

  it('suppresses an English name that only restates the name', () => {
    // Case and surrounding whitespace must not make a name look bilingual.
    expect(distinctEnglishName('Acme Robotics', ' acme robotics ')).toBeUndefined();
  });

  it('trims the value it returns', () => {
    expect(distinctEnglishName('株式会社ABC', '  ABC Corp  ')).toBe('ABC Corp');
  });
});
