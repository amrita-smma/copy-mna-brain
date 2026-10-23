/**
 * Display-text helpers for CRM text. Pure and DOM-free, so they run on the
 * server (DTO boundaries, agent tool output) and in client components alike.
 */

/** What an agent tool writes wherever interaction data is unknown — never 0. */
export const NO_INTERACTION_DATA = 'no data (email sync may be off)';

/** ISO timestamp → `YYYY-MM-DD` (UTC); null for null, empty or unparseable input. */
export function isoDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  // Display text: a non-breaking space would defeat word-boundary clipping
  // and matching, so it reads as a plain space.
  nbsp: ' ',
};

/** One entity layer: `&name;`, `&#123;` or `&#x1F;`. */
const ENTITY = /&(?:#[xX]([0-9a-fA-F]{1,6})|#(\d{1,7})|(amp|lt|gt|quot|apos|nbsp));/g;

/** Passes needed for `&amp;amp;amp;` and similar double/triple escapes. */
const MAX_PASSES = 3;

function fromCodePoint(code: number, original: string): string {
  // NUL, UTF-16 surrogates and anything past Unicode stay as written:
  // `String.fromCodePoint` throws past 0x10FFFF, and one bad name must not
  // fail a whole list.
  if (code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return original;
  return String.fromCodePoint(code);
}

function decodeOnce(value: string): string {
  return value.replace(ENTITY, (match, hex: string | undefined, dec: string | undefined, name: string | undefined) => {
    if (hex !== undefined) return fromCodePoint(parseInt(hex, 16), match);
    if (dec !== undefined) return fromCodePoint(parseInt(dec, 10), match);
    return NAMED_ENTITIES[name!] ?? match;
  });
}

/**
 * Decode the HTML entities that ingest leaves in stored CRM text (`&amp;`,
 * `&lt;`, `&gt;`, `&quot;`, `&apos;`, `&nbsp;`, `&#39;`, `&#x27;` …),
 * repeating until the text is stable, at most three passes, so `&amp;amp;`
 * becomes `&`. Plain `&`, `<`, quotes and non-Latin text pass through
 * unchanged; null and undefined come back as they are.
 *
 * The result is plain text — React escapes it on render. Never feed it to
 * `dangerouslySetInnerHTML`.
 */
export function decodeHtmlEntities(value: string): string;
export function decodeHtmlEntities(value: string | null): string | null;
export function decodeHtmlEntities(value: string | null | undefined): string | null | undefined;
export function decodeHtmlEntities(value: string | null | undefined): string | null | undefined {
  if (value === null || value === undefined || !value.includes('&')) return value;
  let current = value;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = decodeOnce(current);
    if (next === current) break;
    current = next;
  }
  return current;
}
