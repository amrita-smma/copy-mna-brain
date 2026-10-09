/**
 * Number formatting for chart labels and tick marks.
 *
 * The previous renderer wrote bar labels as a bare `${d.value}`, so a value
 * like `-10279` printed at full width and collided with the label on the next
 * bar. Everything here exists to produce the shortest string that still
 * identifies the value.
 */

const UNITS: Array<{ limit: number; divisor: number; suffix: string }> = [
  { limit: 1e12, divisor: 1e12, suffix: 'T' },
  { limit: 1e9, divisor: 1e9, suffix: 'B' },
  { limit: 1e6, divisor: 1e6, suffix: 'M' },
  { limit: 1e3, divisor: 1e3, suffix: 'k' },
];

/** Drop a trailing `.0` so "1.0k" prints as "1k". */
function trimZero(s: string): string {
  return s.replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

/**
 * Compact a number for a chart label: `15894` → `15.9k`, `-1.2e9` → `-1.2B`.
 *
 * Values under 1,000 keep up to `maxDecimals` decimals; larger ones are scaled
 * to k/M/B/T with one decimal, because a three-character label is what fits
 * under a 40pt-wide bar.
 */
export function formatCompact(value: number, maxDecimals = 2): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  for (const unit of UNITS) {
    if (abs >= unit.limit) {
      return `${trimZero((value / unit.divisor).toFixed(1))}${unit.suffix}`;
    }
  }
  if (Number.isInteger(value)) return String(value);
  return trimZero(value.toFixed(maxDecimals));
}

/**
 * `0.1234` is NOT assumed to be a ratio — percentages arrive already scaled.
 *
 * With no explicit precision, a whole number prints whole and a fractional one
 * keeps a single decimal: rounding 13.9% to "14%" loses the only digit that
 * distinguished it from the prior period.
 */
export function formatPercent(value: number, decimals?: number): string {
  if (!Number.isFinite(value)) return '—';
  const places = decimals ?? (Number.isInteger(value) ? 0 : 1);
  return `${trimZero(value.toFixed(places))}%`;
}

/**
 * Round a span up to a "nice" number — 1, 2, 2.5, 5 or 10 times a power of ten.
 * This is what keeps axis ticks on readable values instead of 1,357.4.
 */
export function niceNumber(span: number, round: boolean): number {
  if (span <= 0 || !Number.isFinite(span)) return 1;
  const exponent = Math.floor(Math.log10(span));
  const fraction = span / 10 ** exponent;
  let nice: number;
  if (round) {
    if (fraction < 1.5) nice = 1;
    else if (fraction < 3) nice = 2;
    else if (fraction < 7) nice = 5;
    else nice = 10;
  } else {
    if (fraction <= 1) nice = 1;
    else if (fraction <= 2) nice = 2;
    else if (fraction <= 2.5) nice = 2.5;
    else if (fraction <= 5) nice = 5;
    else nice = 10;
  }
  return nice * 10 ** exponent;
}

export interface AxisTicks {
  min: number;
  max: number;
  step: number;
  values: number[];
}

/**
 * Build an axis domain whose bounds land on round numbers and which always
 * includes zero, so bar heights stay proportional to their values.
 */
export function buildTicks(values: number[], targetCount = 4): AxisTicks {
  const finite = values.filter((v) => Number.isFinite(v));
  const rawMin = Math.min(0, ...finite);
  const rawMax = Math.max(0, ...finite);

  if (rawMin === rawMax) {
    return { min: 0, max: 1, step: 1, values: [0, 1] };
  }

  const step = niceNumber((rawMax - rawMin) / Math.max(1, targetCount), true);
  const min = Math.floor(rawMin / step) * step;
  const max = Math.ceil(rawMax / step) * step;

  const out: number[] = [];
  // Accumulate by index rather than by repeated addition: `0.1 + 0.1 + 0.1`
  // drifts, and a drifted tick prints as 0.30000000000000004.
  const count = Math.round((max - min) / step);
  for (let i = 0; i <= count; i++) {
    out.push(Number((min + i * step).toPrecision(12)));
  }

  return { min, max, step, values: out };
}

/**
 * Truncate a label to a character budget, with an ellipsis.
 *
 * Only used for axis categories, where the slot width is fixed by the number
 * of bars. Prose blocks never truncate — they wrap.
 */
export function truncateLabel(label: string, maxChars: number): string {
  if (maxChars <= 1) return label.slice(0, Math.max(0, maxChars));
  if (label.length <= maxChars) return label;
  return `${label.slice(0, maxChars - 1).trimEnd()}…`;
}
