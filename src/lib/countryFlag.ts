import { countryToAlpha2 } from 'country-to-iso';

// Geography values (`companies.geography`) are stored as free-text country
// NAMES, not codes. To render a flag, resolve the name to its ISO 3166-1
// alpha-2 code (via `country-to-iso`, which tolerates inconsistent inputs like
// "South Korea" / "USA") and derive the emoji from that code — rather than
// hardcoding a flag emoji per country.

/** Convert an ISO 3166-1 alpha-2 code (e.g. "JP") into its flag emoji by mapping
 * each letter to its Unicode regional indicator symbol. */
export function alpha2ToFlag(code: string): string {
  const cc = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '🌐';
  const BASE = 0x1f1e6; // regional indicator symbol 'A'
  return String.fromCodePoint(
    BASE + (cc.charCodeAt(0) - 65),
    BASE + (cc.charCodeAt(1) - 65),
  );
}

/** Disambiguation for ambiguous names `country-to-iso` can't resolve on its own
 * (bare "Korea" is KR vs KP). Kept intentionally minimal — extend only for names
 * the library genuinely can't handle. */
const COUNTRY_ALIASES: Record<string, string> = {
  korea: 'South Korea',
};

/** ISO 3166-1 alpha-2 code for a geography value (country name or raw code), or
 * null when it names no single country (e.g. regions like "Asia Pacific"). */
export function countryCode(value: string): string | null {
  const normalised = COUNTRY_ALIASES[value.trim().toLowerCase()] ?? value;
  return countryToAlpha2(normalised);
}

/** Flag emoji for a geography value: resolves the country name (or raw code) to
 * an ISO 3166-1 alpha-2 code, then derives the emoji. Globe fallback for values
 * with no country (e.g. regions like "Asia Pacific") or unrecognised input. */
export function countryFlag(value: string): string {
  const code = countryCode(value);
  return code ? alpha2ToFlag(code) : '🌐';
}
