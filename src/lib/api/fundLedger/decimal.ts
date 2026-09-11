// ---- Exact Decimal String Arithmetic Helpers ----

export function expandScientificNotation(val: string | number): string | null {
  let s = typeof val === 'number' ? val.toString() : val.trim();
  if (!s) return null;

  const sciMatch = s.match(/^([+-]?)(\d+(\.\d*)?|\.\d+)[eE]([+-]?\d+)$/);
  if (!sciMatch) {
    if (/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) {
      return s;
    }
    return null;
  }

  const sign = sciMatch[1] === '-' ? '-' : '';
  const mantissa = sciMatch[2];
  const exponent = Number.parseInt(sciMatch[4], 10);

  const dotIdx = mantissa.indexOf('.');
  const mInt = dotIdx >= 0 ? mantissa.slice(0, dotIdx) : mantissa;
  const mFrac = dotIdx >= 0 ? mantissa.slice(dotIdx + 1) : '';

  let expanded = '';
  if (exponent > 0) {
    if (mFrac.length <= exponent) {
      expanded = mInt + mFrac.padEnd(exponent, '0');
    } else {
      expanded = mInt + mFrac.slice(0, exponent) + '.' + mFrac.slice(exponent);
    }
  } else if (exponent < 0) {
    const shift = Math.abs(exponent);
    if (mInt.length <= shift) {
      expanded = '0.' + '0'.repeat(shift - mInt.length) + mInt + mFrac;
    } else {
      expanded = mInt.slice(0, mInt.length - shift) + '.' + mInt.slice(mInt.length - shift) + mFrac;
    }
  } else {
    expanded = mFrac ? `${mInt}.${mFrac}` : mInt;
  }

  if (expanded.includes('.')) {
    const [iPart, fPart] = expanded.split('.');
    const cleanI = iPart.replace(/^0+(?=\d)/, '') || '0';
    const cleanF = fPart.replace(/0+$/, '');
    expanded = cleanF ? `${cleanI}.${cleanF}` : cleanI;
  } else {
    expanded = expanded.replace(/^0+(?=\d)/, '') || '0';
  }

  if (expanded === '0') return '0';
  return `${sign}${expanded}`;
}

export function shiftDecimal(val: string | number, places: number): string {
  const expanded = expandScientificNotation(val);
  if (!expanded) return '0';
  let s = expanded;
  if (s === '0' || s === '-0') return '0';

  let isNeg = false;
  if (s.startsWith('-')) {
    isNeg = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }

  const dotIdx = s.indexOf('.');
  let intPart = dotIdx >= 0 ? s.slice(0, dotIdx) : s;
  let fracPart = dotIdx >= 0 ? s.slice(dotIdx + 1) : '';

  if (places > 0) {
    if (fracPart.length <= places) {
      intPart = intPart + fracPart.padEnd(places, '0');
      fracPart = '';
    } else {
      intPart = intPart + fracPart.slice(0, places);
      fracPart = fracPart.slice(places);
    }
  } else if (places < 0) {
    const shift = Math.abs(places);
    if (intPart.length <= shift) {
      fracPart = intPart.padStart(shift, '0') + fracPart;
      intPart = '0';
    } else {
      fracPart = intPart.slice(intPart.length - shift) + fracPart;
      intPart = intPart.slice(0, intPart.length - shift);
    }
  }

  intPart = intPart.replace(/^0+(?=\d)/, '');
  if (!intPart) intPart = '0';

  fracPart = fracPart.replace(/0+$/, '');

  const result = fracPart ? `${intPart}.${fracPart}` : intPart;
  return isNeg && result !== '0' ? `-${result}` : result;
}

export function toRawAmountString(
  val: string | number | null | undefined,
  isScaledInMillions: boolean,
): string | null {
  if (val == null || val === '') return null;
  const expanded = expandScientificNotation(val);
  if (expanded == null) return null;
  return isScaledInMillions ? shiftDecimal(expanded, 6) : shiftDecimal(expanded, 0);
}

export function multiplyDecimalStrings(a: string | number, b: string | number): string {
  let sa = typeof a === 'number' ? a.toString() : a.trim();
  let sb = typeof b === 'number' ? b.toString() : b.trim();
  if (!sa || !sb || sa === '0' || sb === '0') return '0';

  let isNeg = false;
  if (sa.startsWith('-')) {
    isNeg = !isNeg;
    sa = sa.slice(1);
  }
  if (sb.startsWith('-')) {
    isNeg = !isNeg;
    sb = sb.slice(1);
  }

  const dotA = sa.indexOf('.');
  const fracA = dotA >= 0 ? sa.length - dotA - 1 : 0;
  const intA = sa.replace('.', '');

  const dotB = sb.indexOf('.');
  const fracB = dotB >= 0 ? sb.length - dotB - 1 : 0;
  const intB = sb.replace('.', '');

  const productBigInt = BigInt(intA) * BigInt(intB);
  let prodStr = productBigInt.toString();
  const totalFrac = fracA + fracB;

  if (totalFrac > 0) {
    if (prodStr.length <= totalFrac) {
      prodStr = '0.' + prodStr.padStart(totalFrac, '0');
    } else {
      const splitAt = prodStr.length - totalFrac;
      prodStr = prodStr.slice(0, splitAt) + '.' + prodStr.slice(splitAt);
    }
    prodStr = prodStr.replace(/(\.\d*?[1-9])0+$/, '$1').replace(/\.0+$/, '');
  }

  return isNeg && prodStr !== '0' ? `-${prodStr}` : prodStr;
}

export function addDecimalStrings(a: string | number, b: string | number): string {
  let sa = typeof a === 'number' ? a.toString() : a.trim();
  let sb = typeof b === 'number' ? b.toString() : b.trim();
  if (!sa) sa = '0';
  if (!sb) sb = '0';

  const dotA = sa.indexOf('.');
  const dotB = sb.indexOf('.');
  const fracA = dotA >= 0 ? sa.length - dotA - 1 : 0;
  const fracB = dotB >= 0 ? sb.length - dotB - 1 : 0;
  const maxFrac = Math.max(fracA, fracB);

  const normA = shiftDecimal(sa, maxFrac);
  const normB = shiftDecimal(sb, maxFrac);

  const sumBigInt = BigInt(normA) + BigInt(normB);
  return shiftDecimal(sumBigInt.toString(), -maxFrac);
}
