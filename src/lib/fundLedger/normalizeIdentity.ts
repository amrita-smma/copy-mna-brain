/**
 * Centralized identity normalization and bilingual utilities for Fund Ledger v2.
 *
 * Provides canonical normalization for assets, funds, investors, and funding sources
 * to guarantee workspace-global uniqueness and deduplication across imports, APIs,
 * and background services.
 */

/**
 * Splits bilingual Chinese/English strings.
 * Splits at the first ASCII letter following a CJK character or closing parenthesis.
 * Returns { zh: s, en: null } when no CJK characters are present.
 */
export function splitBilingual(raw: string | null | undefined): { zh: string; en: string | null } {
  if (!raw) return { zh: '', en: null };
  const s = raw
    .replace(/[\u3000\t\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return { zh: '', en: null };
  if (!/[一-鿿]/.test(s)) return { zh: s, en: null };
  const m = s.match(/^(.*?[一-鿿）)])\s*(?:[(（]\s*([A-Za-z].*?)\s*[)）]|([A-Za-z].*))$/);
  if (!m) return { zh: s, en: null };
  const en = (m[2] || m[3])?.trim() || null;
  return { zh: m[1].trim(), en };
}

/**
 * Normalizes any master data name (investor, fund, asset, funding source)
 * to a canonical business identity key:
 * - Trims leading/trailing whitespace
 * - Replaces full-width spaces and collapses whitespace sequences to single space
 * - Normalizes full-width parentheses （ ） to ( )
 * - Extracts native CJK name for bilingual strings
 * - Case folds to lowercase
 */
export function normalizeCanonicalName(name: string | null | undefined): string {
  if (!name) return '';
  const clean = name
    .replace(/[\u3000\t\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .trim();
  if (!clean) return '';

  const { zh } = splitBilingual(clean);
  let candidate = (zh.trim() || clean).toLowerCase();

  // Remove spaces between CJK characters and parentheses
  while (/([一-鿿()（）])\s+([一-鿿()（）])/.test(candidate)) {
    candidate = candidate.replace(/([一-鿿()（）])\s+([一-鿿()（）])/g, '$1$2');
  }

  return candidate;
}

/**
 * Normalizes an investor name for matching.
 * Exact alias/compatible implementation of normalizeCanonicalName.
 */
export function normalizeInvestorName(name: string | null | undefined): string {
  return normalizeCanonicalName(name);
}

/**
 * Checks if two master entity names resolve to the exact same canonical business identity.
 */
export function isSameBusinessIdentity(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const normA = normalizeCanonicalName(a);
  const normB = normalizeCanonicalName(b);
  if (!normA || !normB) return false;
  return normA === normB;
}
