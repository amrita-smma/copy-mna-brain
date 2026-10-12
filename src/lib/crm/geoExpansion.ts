import { countryCode } from "@/lib/countryFlag";

/**
 * Deal geography → banker coverage-region matching.
 *
 * `correspondents.coverage_region` is free text written by whoever curated the
 * contact: "North America", "Southeast Asia", "Greater China", "Global",
 * "Indonesia". A deal, on the other hand, is described by the *country* it sits
 * in ("a US company we want to LBO"). A literal substring match between the two
 * finds nothing — "United States" does not appear anywhere in "North America".
 *
 * This module bridges the two: it resolves the asked-for place to the set of
 * coverage labels that would plausibly cover it, split into two tiers so the
 * caller can rank a precise cover above an umbrella one.
 *
 *   expandGeography("United States")
 *     → exact: ["United States", "USA", "U.S.", "America", "North America"]
 *       broad: ["Americas", "Global", "Worldwide", "International"]
 *
 * Country NAME → ISO alpha-2 resolution is delegated to `country-to-iso` (via
 * `@/lib/countryFlag`) rather than a hand-maintained name map — see the
 * Country Codes rule in CLAUDE.md. Only the code → region grouping lives here,
 * because no dependency in this repo provides it.
 */

/** Place names that cover everything, whatever was asked for. */
const GLOBAL_TOKENS = ["Global", "Worldwide", "International"];

/**
 * Canonical region → its immediate parent. Walking this chain upward is what
 * produces the `broad` tier; walking it downward produces the sub-regions that
 * still count as a precise cover.
 */
const REGION_PARENTS: Record<string, string[]> = {
  "North America": ["Americas"],
  "Latin America": ["Americas"],
  Americas: ["Global"],
  Nordics: ["Northern Europe"],
  DACH: ["Western Europe"],
  Benelux: ["Western Europe"],
  "Western Europe": ["Europe"],
  "Northern Europe": ["Europe"],
  "Southern Europe": ["Europe"],
  "Eastern Europe": ["Europe"],
  Europe: ["EMEA"],
  "Middle East": ["MENA"],
  // North Africa rolls up both ways: a MENA desk and an Africa desk each cover it.
  "North Africa": ["MENA", "Africa"],
  MENA: ["EMEA"],
  "Sub-Saharan Africa": ["Africa"],
  Africa: ["EMEA"],
  EMEA: ["Global"],
  "Greater China": ["East Asia"],
  "East Asia": ["Asia Pacific"],
  "Southeast Asia": ["Asia Pacific"],
  "South Asia": ["Asia Pacific"],
  "Central Asia": ["Asia Pacific"],
  Oceania: ["Asia Pacific"],
  "Asia Pacific": ["Global"],
};

/**
 * Canonical region → the ISO 3166-1 alpha-2 codes it contains. A country may
 * appear under several regions (Mexico is both North America and Latin
 * America; Turkey is both Middle East and Southern Europe) — every region that
 * lists it is treated as covering it.
 *
 * Only the grouping is maintained here; a country missing from every list
 * still works, it just gets no regional expansion beyond the global tokens.
 */
const REGION_MEMBERS: Record<string, string[]> = {
  "North America": ["US", "CA", "MX", "BM", "GL", "PM"],
  "Latin America": [
    "MX", "BR", "AR", "CL", "CO", "PE", "VE", "EC", "BO", "PY", "UY", "GY",
    "SR", "GF", "PA", "CR", "NI", "HN", "SV", "GT", "BZ", "CU", "DO", "HT",
    "JM", "TT", "PR", "BS", "BB", "AG", "DM", "GD", "KN", "LC", "VC", "AW",
    "CW", "KY", "VG", "TC",
  ],
  "Western Europe": ["FR", "DE", "NL", "BE", "LU", "AT", "CH", "LI", "MC"],
  DACH: ["DE", "AT", "CH"],
  Benelux: ["NL", "BE", "LU"],
  "Northern Europe": [
    "GB", "IE", "SE", "NO", "DK", "FI", "IS", "EE", "LV", "LT", "FO", "GG",
    "JE", "IM",
  ],
  Nordics: ["SE", "NO", "DK", "FI", "IS"],
  "Southern Europe": [
    "IT", "ES", "PT", "GR", "MT", "CY", "HR", "SI", "RS", "BA", "ME", "MK",
    "AL", "AD", "SM", "VA", "TR",
  ],
  "Eastern Europe": ["PL", "CZ", "SK", "HU", "RO", "BG", "UA", "BY", "MD", "RU"],
  "Middle East": [
    "AE", "SA", "QA", "KW", "BH", "OM", "IL", "JO", "LB", "SY", "IQ", "IR",
    "YE", "TR",
  ],
  "North Africa": ["EG", "LY", "TN", "DZ", "MA", "SD"],
  "Sub-Saharan Africa": [
    "NG", "ZA", "KE", "GH", "ET", "TZ", "UG", "CI", "SN", "CM", "AO", "MZ",
    "ZM", "ZW", "BW", "NA", "RW", "MW", "ML", "BF", "NE", "TD", "CD", "CG",
    "GA", "GQ", "BJ", "TG", "SL", "LR", "GN", "GW", "GM", "MR", "SO", "ER",
    "DJ", "SS", "MG", "MU", "SC", "LS", "SZ", "CV", "ST", "BI", "KM",
  ],
  "Greater China": ["CN", "HK", "MO", "TW"],
  "East Asia": ["CN", "HK", "MO", "TW", "JP", "KR", "KP", "MN"],
  "Southeast Asia": [
    "ID", "MY", "SG", "TH", "VN", "PH", "MM", "KH", "LA", "BN", "TL",
  ],
  "South Asia": ["IN", "PK", "BD", "LK", "NP", "BT", "MV", "AF"],
  "Central Asia": ["KZ", "UZ", "TM", "KG", "TJ", "AZ", "GE", "AM"],
  Oceania: [
    "AU", "NZ", "PG", "FJ", "NC", "SB", "VU", "WS", "TO", "PF", "GU",
  ],
};

/** Written-out spellings a curator might use for a canonical region. */
const REGION_ALIASES: Record<string, string> = {
  apac: "Asia Pacific",
  "asia pacific": "Asia Pacific",
  "asia-pacific": "Asia Pacific",
  asiapac: "Asia Pacific",
  asia: "Asia Pacific",
  "south east asia": "Southeast Asia",
  "south-east asia": "Southeast Asia",
  sea: "Southeast Asia",
  asean: "Southeast Asia",
  "greater china": "Greater China",
  "china region": "Greater China",
  "north asia": "East Asia",
  "east asia": "East Asia",
  "northeast asia": "East Asia",
  "south asia": "South Asia",
  "indian subcontinent": "South Asia",
  "central asia": "Central Asia",
  oceania: "Oceania",
  anz: "Oceania",
  "australia and new zealand": "Oceania",
  emea: "EMEA",
  "europe middle east and africa": "EMEA",
  europe: "Europe",
  "western europe": "Western Europe",
  "northern europe": "Northern Europe",
  "southern europe": "Southern Europe",
  "eastern europe": "Eastern Europe",
  "central europe": "Eastern Europe",
  "cee": "Eastern Europe",
  nordics: "Nordics",
  nordic: "Nordics",
  scandinavia: "Nordics",
  dach: "DACH",
  benelux: "Benelux",
  iberia: "Southern Europe",
  mena: "MENA",
  "middle east": "Middle East",
  "middle east and north africa": "MENA",
  gcc: "Middle East",
  gulf: "Middle East",
  "north africa": "North Africa",
  africa: "Africa",
  "sub saharan africa": "Sub-Saharan Africa",
  "sub-saharan africa": "Sub-Saharan Africa",
  ssa: "Sub-Saharan Africa",
  americas: "Americas",
  "north america": "North America",
  nam: "North America",
  "northern america": "North America",
  "latin america": "Latin America",
  latam: "Latin America",
  "south america": "Latin America",
  "central america": "Latin America",
  caribbean: "Latin America",
};

/**
 * Extra spellings for countries whose coverage label is usually an
 * abbreviation. Keyed by ISO alpha-2 so `country-to-iso` still does the
 * name → code resolution. Two-letter forms ("US", "UK") are included because
 * matching is word-boundary anchored, not substring — see `expandGeography`.
 */
const COUNTRY_NAME_ALIASES: Record<string, string[]> = {
  // No bare "America": matching is word-boundary anchored, so it would also
  // hit a "Latin America" desk for a US deal.
  US: ["United States", "USA", "U.S.", "US"],
  GB: ["United Kingdom", "UK", "Britain", "Great Britain"],
  AE: ["United Arab Emirates", "UAE"],
  KR: ["South Korea", "Korea"],
  CN: ["China", "PRC", "Mainland China"],
  HK: ["Hong Kong", "HK"],
  TW: ["Taiwan"],
  JP: ["Japan"],
  SG: ["Singapore"],
  ID: ["Indonesia"],
  MY: ["Malaysia"],
  TH: ["Thailand"],
  VN: ["Vietnam", "Viet Nam"],
  PH: ["Philippines"],
  IN: ["India"],
  AU: ["Australia"],
  NZ: ["New Zealand"],
  DE: ["Germany"],
  FR: ["France"],
  NL: ["Netherlands", "Holland"],
  CH: ["Switzerland"],
  SA: ["Saudi Arabia", "KSA"],
  BR: ["Brazil"],
  MX: ["Mexico"],
  CA: ["Canada"],
  ZA: ["South Africa"],
};

export interface GeoExpansion {
  /** The place itself, plus regions that cover it precisely. */
  exact: string[];
  /** Umbrella regions (continent, EMEA/APAC, Global) that still cover it. */
  broad: string[];
  /** The canonical region the input resolved to, when it named one. */
  region: string | null;
  /** ISO 3166-1 alpha-2 of the input, when it named a country. */
  countryCode: string | null;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.,/]/g, " ")
    .replace(/&/g, " and ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Deduplicate case-insensitively, keeping first-seen casing and order. */
function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/** Every region that lists this ISO alpha-2 code as a member. */
function regionsContaining(code: string): string[] {
  return Object.keys(REGION_MEMBERS).filter((region) =>
    REGION_MEMBERS[region].includes(code),
  );
}

/** Every region above this one, excluding "Global" (handled separately). */
function ancestors(region: string): string[] {
  const out: string[] = [];
  const queue = [...(REGION_PARENTS[region] ?? [])];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === "Global" || out.includes(current)) continue;
    out.push(current);
    queue.push(...(REGION_PARENTS[current] ?? []));
  }
  return out;
}

/** The regions nested under a region (a "Greater China" desk covers an APAC ask). */
function descendants(region: string): string[] {
  return Object.keys(REGION_PARENTS).filter((candidate) =>
    ancestors(candidate).includes(region),
  );
}

/**
 * Coverage labels that would cover `value`, split into a precise tier and an
 * umbrella tier. Returns empty tiers (beyond the global tokens) for input that
 * names neither a country nor a known region, so an unrecognised string never
 * silently matches everyone.
 */
export function expandGeography(value: string): GeoExpansion {
  const raw = value.trim();
  if (!raw) {
    return { exact: [], broad: [], region: null, countryCode: null };
  }

  const key = normalize(raw);
  const aliased = REGION_ALIASES[key];
  const region = aliased ?? (REGION_PARENTS[raw] || REGION_MEMBERS[raw] ? raw : null);

  if (region === "Global" || key === "global" || key === "worldwide") {
    return { exact: dedupe(GLOBAL_TOKENS), broad: [], region: "Global", countryCode: null };
  }

  if (region) {
    return {
      exact: dedupe([raw, region, ...descendants(region)]),
      broad: dedupe([...ancestors(region), ...GLOBAL_TOKENS]),
      region,
      countryCode: null,
    };
  }

  const code = countryCode(raw);
  if (!code) {
    // Neither a country nor a region — e.g. a city or a typo. Match the string
    // itself and nothing else; the caller's other facets carry the query. In
    // particular NOT the global tokens: "Atlantis" must not quietly return
    // every globally-covering banker as if it were a geography match.
    return { exact: [raw], broad: [], region: null, countryCode: null };
  }

  const containing = regionsContaining(code);
  const above = dedupe(containing.flatMap(ancestors)).filter(
    (candidate) => !containing.includes(candidate),
  );

  // When we have a curated alias list for this country, it IS the spelling set
  // — the raw input is dropped. `country-to-iso` resolves loose names like
  // "America" to US, and echoing that back into `exact` would reintroduce the
  // `\yAmerica\y` match against a "Latin America" desk.
  const aliases = COUNTRY_NAME_ALIASES[code];
  return {
    exact: dedupe([...(aliases ?? [raw]), ...containing]),
    broad: dedupe([...above, ...GLOBAL_TOKENS]),
    region: null,
    countryCode: code,
  };
}
