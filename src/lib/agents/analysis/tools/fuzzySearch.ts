/**
 * Small, dependency-free fuzzy name matcher shared by the investment tools.
 *
 * The investment Copilot constantly has to turn a name the user typed ("how is
 * acme doing?") into a concrete record — a fund, a holding, an investor (LP),
 * or a source of capital. Plain `includes()` matching fails on the ways people
 * actually write names: legal suffixes ("Acme Holdings Pte Ltd"), reordered or
 * partial words ("Acme Holdings" vs "Holdings, Acme"), acronyms ("GF II" for
 * "Growth Fund II"), and typos ("Acne").
 *
 * The scoring ladder below is deliberately simple and explainable — exact,
 * prefix, substring, token overlap, acronym, then a character-similarity
 * fallback (Dice bigram + Levenshtein ratio) that catches typos.
 */

/**
 * Trailing corporate/legal-form tokens that carry no identifying signal.
 * Stripped from the END of a name only, and never all of them (a record
 * literally named "Holdings" still normalizes to "holdings").
 *
 * Deliberately excludes words like "fund", "capital", "partners" — those are
 * meaningful parts of fund and investor names in this domain.
 */
const LEGAL_SUFFIXES = new Set([
  'ab',
  'ag',
  'as',
  'bhd',
  'bv',
  'co',
  'company',
  'corp',
  'corporation',
  'gmbh',
  'inc',
  'incorporated',
  'kk',
  'lda',
  'limited',
  'llc',
  'llp',
  'lp',
  'ltd',
  'nv',
  'oy',
  'plc',
  'pt',
  'pte',
  'sa',
  'sas',
  'sdn',
  'spa',
  'srl',
  'tbk',
]);

/** Score at or above which a candidate is considered a plausible match. */
export const DEFAULT_MATCH_THRESHOLD = 0.5;

/** Lowercase, de-accent, and reduce a name to bare alphanumeric words. */
export function normalizeName(raw: string | null | undefined): string {
  return (raw ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Normalized words with trailing legal-form suffixes dropped. */
export function tokenize(raw: string | null | undefined): string[] {
  const tokens = normalizeName(raw).split(' ').filter(Boolean);
  let end = tokens.length;
  // Never strip every token — "Ltd" alone stays "ltd".
  while (end > 1 && LEGAL_SUFFIXES.has(tokens[end - 1])) end -= 1;
  return tokens.slice(0, end);
}

/** The canonical comparison form of a name: normalized, suffix-stripped. */
export function canonicalName(raw: string | null | undefined): string {
  return tokenize(raw).join(' ');
}

function bigrams(value: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < value.length - 1; i += 1) out.push(value.slice(i, i + 2));
  return out;
}

/** Sørensen–Dice coefficient over character bigrams (0..1). */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;

  const aGrams = bigrams(a);
  const counts = new Map<string, number>();
  for (const g of aGrams) counts.set(g, (counts.get(g) ?? 0) + 1);

  let hits = 0;
  const bGrams = bigrams(b);
  for (const g of bGrams) {
    const left = counts.get(g) ?? 0;
    if (left > 0) {
      counts.set(g, left - 1);
      hits += 1;
    }
  }
  return (2 * hits) / (aGrams.length + bGrams.length);
}

/** Levenshtein edit distance (names are short, so the O(n·m) table is fine). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

/** 1 − (edit distance / longer length), clamped to 0..1. */
function levenshteinRatio(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) return 0;
  return Math.max(0, 1 - levenshtein(a, b) / longest);
}

/**
 * Similarity of `query` to `name` on a 0..1 scale. 1 means the two names are
 * the same once normalized; anything at or above DEFAULT_MATCH_THRESHOLD is
 * worth showing the user.
 */
export function nameScore(query: string, name: string | null | undefined): number {
  const q = canonicalName(query);
  const n = canonicalName(name);
  if (!q || !n) return 0;
  if (q === n) return 1;

  // "acme" → "acme holdco", and the reverse when the user over-specifies.
  // Both sides need ≥3 chars so a stray "co"/"pt" doesn't match everything.
  const containable = (s: string) => s.length >= 3;
  if ((containable(q) && n.startsWith(q)) || (containable(n) && q.startsWith(n))) return 0.95;
  if ((containable(q) && n.includes(q)) || (containable(n) && q.includes(n))) return 0.88;

  const qTokens = q.split(' ');
  const nTokens = n.split(' ');

  const matched = qTokens.filter((qt) =>
    nTokens.some((nt) => nt === qt || nt.startsWith(qt) || qt.startsWith(nt)),
  ).length;
  if (matched === qTokens.length) return 0.85;

  // "gf" → "growth fund", "abc" → "Alpha Beta Capital".
  if (qTokens.length === 1 && q.length >= 2 && nTokens.length >= 2) {
    const initials = nTokens.map((t) => t[0]).join('');
    if (initials === q) return 0.82;
    if (initials.startsWith(q)) return 0.75;
  }

  const overlap = matched / qTokens.length;
  const tokenScore = overlap >= 0.5 ? 0.6 + 0.2 * overlap : 0;

  // Typo tolerance: "acne" → "acme", "gowth fund" → "growth fund".
  const charScore = Math.max(diceCoefficient(q, n), levenshteinRatio(q, n)) * 0.8;

  return Math.max(tokenScore, charScore);
}

export interface FuzzyMatch<T> {
  item: T;
  /** 0..1 similarity of the query to `matchedOn`. */
  score: number;
  /** The specific name field that produced the score. */
  matchedOn: string;
}

/**
 * Rank `items` against `query`, scoring each item on its best-matching name.
 * Items scoring below `threshold` are dropped. Ties break on the matched name
 * so results are stable across calls.
 */
export function fuzzySearch<T>(
  query: string,
  items: readonly T[],
  getNames: (item: T) => Array<string | null | undefined>,
  opts: { threshold?: number; limit?: number } = {},
): Array<FuzzyMatch<T>> {
  const threshold = opts.threshold ?? DEFAULT_MATCH_THRESHOLD;
  const matches: Array<FuzzyMatch<T>> = [];

  for (const item of items) {
    let best: FuzzyMatch<T> | null = null;
    for (const name of getNames(item)) {
      if (!name) continue;
      const score = nameScore(query, name);
      if (!best || score > best.score) best = { item, score, matchedOn: name };
    }
    if (best && best.score >= threshold) matches.push(best);
  }

  matches.sort((a, b) => b.score - a.score || a.matchedOn.localeCompare(b.matchedOn));
  return opts.limit != null ? matches.slice(0, opts.limit) : matches;
}

/** Human-readable strength label for a score, used in tool output. */
export function matchLabel(score: number): string {
  if (score >= 0.999) return 'exact';
  if (score >= 0.85) return 'strong';
  if (score >= 0.7) return 'partial';
  return 'weak';
}
