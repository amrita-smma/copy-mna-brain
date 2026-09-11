/**
 * Exact decimal arithmetic helper over numeric strings using BigInt.
 * Avoids JavaScript floating-point representation bugs (parseFloat / Number).
 * All money and quantity calculations in the Fund Ledger use this helper.
 *
 * Strict string boundary: all public inputs MUST be strings.
 */

const B_ZERO = BigInt(0);
const B_ONE = BigInt(1);
const B_NEG_ONE = BigInt(-1);
const B_TEN = BigInt(10);
const B_TWO = BigInt(2);

const INTERNAL_SCALE = 18;
const INTERNAL_MULTIPLIER = B_TEN ** BigInt(INTERNAL_SCALE);

/**
 * Expands scientific notation strings (e.g., "1e-5", "1.23e+4") into standard decimal string.
 */
function expandScientific(val: string): string {
  if (!/[eE]/.test(val)) return val;

  const [mantissaStr, exponentStr] = val.split(/[eE]/);
  const exponent = Number.parseInt(exponentStr, 10);
  if (Number.isNaN(exponent)) return val;

  let sign = '';
  let m = mantissaStr;
  if (m.startsWith('-')) {
    sign = '-';
    m = m.slice(1);
  } else if (m.startsWith('+')) {
    m = m.slice(1);
  }

  const [intPart = '0', fracPart = ''] = m.split('.');
  const whole = intPart + fracPart;

  if (exponent >= 0) {
    const shift = exponent - fracPart.length;
    if (shift >= 0) {
      return sign + whole + '0'.repeat(shift);
    }
    const dotPos = intPart.length + exponent;
    return sign + whole.slice(0, dotPos) + '.' + whole.slice(dotPos);
  }

  const leadingZeros = -exponent - intPart.length;
  if (leadingZeros >= 0) {
    return sign + '0.' + '0'.repeat(leadingZeros) + whole;
  }
  const dotPos = intPart.length + exponent;
  return sign + whole.slice(0, dotPos) + '.' + whole.slice(dotPos);
}
/**
 * Parses a decimal string into a BigInt scaled by INTERNAL_SCALE (18 decimal places).
 * Strictly rejects non-string inputs at runtime.
 */
export function parseToScaledBigInt(val: string): bigint {
  if (typeof val !== 'string') {
    throw new TypeError(
      `Expected decimal string, received ${typeof val}: ${String(val)}`,
    );
  }

  let s = val.trim();
  if (!s || s === '0' || s === '-0' || s === '+0') {
    return B_ZERO;
  }

  s = expandScientific(s);

  let sign = B_ONE;
  if (s.startsWith('-')) {
    sign = B_NEG_ONE;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }

  const parts = s.split('.');
  const intPartStr = parts[0] || '0';
  let fracPartStr = parts[1] || '';

  if (fracPartStr.length > INTERNAL_SCALE) {
    const discarded = fracPartStr.slice(INTERNAL_SCALE);
    fracPartStr = fracPartStr.slice(0, INTERNAL_SCALE);
    let intVal = BigInt(intPartStr + fracPartStr);
    if (discarded.length > 0 && discarded[0] >= '5') {
      intVal += B_ONE;
    }
    return sign * intVal;
  }

  fracPartStr = fracPartStr.padEnd(INTERNAL_SCALE, '0');
  const combined = intPartStr + fracPartStr;
  return sign * BigInt(combined);
}

/**
 * Formats a scaled BigInt back to a decimal string at specified scale (default 8).
 */
export function formatScaledBigInt(scaled: bigint, scale = 8): string {
  if (scaled === B_ZERO) {
    return scale > 0 ? `0.${'0'.repeat(scale)}` : '0';
  }

  const isNeg = scaled < B_ZERO;
  const absVal = isNeg ? -scaled : scaled;

  const divisor = B_TEN ** BigInt(INTERNAL_SCALE - scale);
  // Round to target scale
  let rounded = absVal / divisor;
  const remainder = absVal % divisor;
  const halfDivisor = divisor / B_TWO;

  if (divisor > B_ONE && remainder >= halfDivisor) {
    rounded += B_ONE;
  }

  const targetMultiplier = B_TEN ** BigInt(scale);
  const intPart = rounded / targetMultiplier;
  const fracPart = rounded % targetMultiplier;

  const signStr = isNeg && rounded > B_ZERO ? '-' : '';

  if (scale === 0) {
    return `${signStr}${intPart.toString()}`;
  }

  const fracStr = fracPart.toString().padStart(scale, '0');
  return `${signStr}${intPart.toString()}.${fracStr}`;
}

/**
 * Normalizes any numeric string to a decimal string with specified scale (default 8).
 */
export function toDecimalString(val: string, scale = 8): string {
  return formatScaledBigInt(parseToScaledBigInt(val), scale);
}

/**
 * Adds two numeric string values with exact precision.
 */
export function flAdd(a: string, b: string, scale = 8): string {
  const scaledA = parseToScaledBigInt(a);
  const scaledB = parseToScaledBigInt(b);
  return formatScaledBigInt(scaledA + scaledB, scale);
}

/**
 * Subtracts b from a (a - b) with exact precision.
 */
export function flSub(a: string, b: string, scale = 8): string {
  const scaledA = parseToScaledBigInt(a);
  const scaledB = parseToScaledBigInt(b);
  return formatScaledBigInt(scaledA - scaledB, scale);
}

/**
 * Multiplies a and b with exact precision.
 */
export function flMul(a: string, b: string, scale = 8): string {
  const scaledA = parseToScaledBigInt(a);
  const scaledB = parseToScaledBigInt(b);
  const scaledProduct = (scaledA * scaledB) / INTERNAL_MULTIPLIER;
  return formatScaledBigInt(scaledProduct, scale);
}

/**
 * Divides a by b (a / b) with exact precision.
 */
export function flDiv(a: string, b: string, scale = 8): string {
  const scaledA = parseToScaledBigInt(a);
  const scaledB = parseToScaledBigInt(b);
  if (scaledB === B_ZERO) {
    throw new RangeError('Division by zero in flDecimal');
  }
  const scaledQuotient = (scaledA * INTERNAL_MULTIPLIER) / scaledB;
  return formatScaledBigInt(scaledQuotient, scale);
}

/**
 * Negates a numeric string value (-a).
 */
export function flNeg(val: string, scale = 8): string {
  const scaled = parseToScaledBigInt(val);
  return formatScaledBigInt(-scaled, scale);
}

/**
 * Absolute value of a numeric string value (|a|).
 */
export function flAbs(val: string, scale = 8): string {
  const scaled = parseToScaledBigInt(val);
  return formatScaledBigInt(scaled < B_ZERO ? -scaled : scaled, scale);
}

/**
 * Compares a and b:
 * returns -1 if a < b, 0 if a == b, 1 if a > b.
 */
export function flCmp(a: string, b: string): number {
  const scaledA = parseToScaledBigInt(a);
  const scaledB = parseToScaledBigInt(b);
  if (scaledA < scaledB) return -1;
  if (scaledA > scaledB) return 1;
  return 0;
}

/** Returns true if a === b */
export function flEq(a: string, b: string): boolean {
  return flCmp(a, b) === 0;
}

/** Returns true if a !== b */
export function flNeq(a: string, b: string): boolean {
  return flCmp(a, b) !== 0;
}

/** Returns true if a > b */
export function flGt(a: string, b: string): boolean {
  return flCmp(a, b) > 0;
}

/** Returns true if a >= b */
export function flGte(a: string, b: string): boolean {
  return flCmp(a, b) >= 0;
}

/** Returns true if a < b */
export function flLt(a: string, b: string): boolean {
  return flCmp(a, b) < 0;
}

/** Returns true if a <= b */
export function flLte(a: string, b: string): boolean {
  return flCmp(a, b) <= 0;
}

/** Returns true if val === 0 */
export function flIsZero(val: string): boolean {
  return parseToScaledBigInt(val) === B_ZERO;
}

/** Returns true if val > 0 */
export function flIsPositive(val: string): boolean {
  return parseToScaledBigInt(val) > B_ZERO;
}

/** Returns true if val < 0 */
export function flIsNegative(val: string): boolean {
  return parseToScaledBigInt(val) < B_ZERO;
}

/**
 * Sums an array of numeric strings.
 */
export function flSum(values: string[], scale = 8): string {
  let total = B_ZERO;
  for (const v of values) {
    total += parseToScaledBigInt(v);
  }
  return formatScaledBigInt(total, scale);
}

/**
 * Nullable variant of `toExactDecimalString`: `null`/`undefined`/blank-string in,
 * `null` out. Anything else goes through the strict converter.
 */
export function safeExactDecimalString(val: number | string | null | undefined, scale = 8): string | null {
  if (val == null) return null;
  if (typeof val === "string" && !val.trim()) return null;
  return toExactDecimalString(val, scale);
}

/**
 * Validates and converts a number, string, or decimal representation into an exact decimal string.
 */
export function toExactDecimalString(val: number | string | null | undefined, scale = 8): string {
  if (val == null) {
    throw new TypeError(`Expected non-null decimal value, received: ${val}`);
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) {
      throw new TypeError("Expected non-empty decimal string");
    }
    return toDecimalString(trimmed, scale);
  }
  if (typeof val === "number") {
    if (!Number.isFinite(val)) {
      throw new TypeError(`Expected finite number, received: ${val}`);
    }
    const fullStr = val.toLocaleString("fullwide", {
      useGrouping: false,
      maximumFractionDigits: 20,
    });
    return toDecimalString(fullStr, scale);
  }
  throw new TypeError(`Expected number or string, received ${typeof val}`);
}
