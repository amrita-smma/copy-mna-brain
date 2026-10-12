/**
 * Deal need → banker desk/expertise matching.
 *
 * A user describes the *deal* ("we want to LBO a US company", "they're
 * refinancing", "sell-side carve-out"); the CRM stores the *desk*
 * (`correspondents.department` = "Leveraged Finance", "DCM", "M&A") and a free
 * text `specialization` / `title` / `bio`. Nothing in "LBO" literally appears
 * in "Leveraged Finance", so this module translates one into the other.
 *
 *   expandDealType("LBO")
 *     → departments: ["Leveraged Finance", "LevFin", "Debt Capital Markets",
 *                     "DCM", "Financial Sponsors", …]
 *       keywords:    ["LBO", "leveraged", "buyout", "sponsor", …]
 *
 * Unmatched input is passed through verbatim rather than dropped, so a desk
 * name we have no playbook entry for still searches for itself.
 */

interface PlaybookEntry {
  /**
   * Lower-case phrases that identify this kind of mandate. Matched as a
   * word-prefix against the normalized input, so "refinanc" catches
   * "refinancing" and "merger" catches "mergers".
   */
  triggers: string[];
  /** Desk names that run this kind of mandate (`department`). */
  departments: string[];
  /** Terms worth looking for in `specialization` / `title` / `bio`. */
  keywords: string[];
}

const PLAYBOOK: PlaybookEntry[] = [
  {
    triggers: [
      "lbo", "leveraged buyout", "buyout", "sponsor", "take private",
      "take-private", "acquisition financing", "acquisition finance",
      "staple", "mbo", "management buyout", "recap",
    ],
    departments: [
      "Leveraged Finance", "LevFin", "Debt Capital Markets", "DCM",
      "Financial Sponsors", "Sponsor Coverage", "Sponsors",
      "Acquisition Finance", "Private Credit", "Syndicated Finance",
      "Leveraged Capital Markets",
    ],
    keywords: [
      "LBO", "leveraged", "buyout", "sponsor", "acquisition financing",
      "staple financing", "unitranche", "mezzanine", "take-private",
    ],
  },
  {
    triggers: [
      "m and a", "merger", "acquisition", "acquire", "takeover", "sell-side",
      "sellside", "sell side", "buy-side", "buyside", "buy side",
      "divestiture", "divestment", "carve-out", "carve out", "disposal",
      "tender offer", "joint venture", "consolidation", "roll-up", "roll up",
    ],
    departments: [
      "M&A", "Mergers & Acquisitions", "Corporate Finance", "Advisory",
      "Investment Banking", "Sector Coverage", "Corporate Development",
    ],
    keywords: [
      "M&A", "merger", "acquisition", "cross-border", "sell-side", "buy-side",
      "carve-out", "divestiture", "roll-up",
    ],
  },
  {
    triggers: [
      "ipo", "listing", "list ", "equity raise", "equity offering",
      "follow-on", "follow on", "rights issue", "placement", "ecm",
      "pre-ipo", "secondary offering", "block trade", "going public",
    ],
    departments: [
      "ECM", "Equity Capital Markets", "Capital Markets", "Equities",
    ],
    keywords: [
      "IPO", "listing", "equity offering", "follow-on", "rights issue",
      "placement", "block trade",
    ],
  },
  {
    triggers: [
      "debt", "bond", "refinanc", "loan", "credit facility", "dcm",
      "high yield", "high-yield", "term loan", "notes issuance",
      "leverage", "capital structure", "mezzanine",
    ],
    departments: [
      "DCM", "Debt Capital Markets", "Leveraged Finance", "Private Credit",
      "Structured Finance", "Debt Advisory", "Credit",
    ],
    keywords: [
      "debt", "bond", "high yield", "refinancing", "term loan", "credit",
      "financing", "capital structure",
    ],
  },
  {
    triggers: [
      "restructuring", "distressed", "chapter 11", "workout", "insolvency",
      "special situation", "turnaround", "bankrupt",
    ],
    departments: [
      "Restructuring", "Special Situations", "Distressed", "Debt Advisory",
    ],
    keywords: [
      "restructuring", "distressed", "workout", "special situations",
      "turnaround",
    ],
  },
  {
    triggers: [
      "growth equity", "venture", "series a", "series b", "series c",
      "minority stake", "private placement", "growth capital",
    ],
    departments: [
      "Growth Equity", "Private Capital", "Private Placements",
      "Investment Team",
    ],
    keywords: ["growth equity", "venture", "minority", "private placement"],
  },
  {
    triggers: ["valuation", "fairness opinion", "appraisal"],
    departments: ["Valuation", "Advisory"],
    keywords: ["valuation", "fairness opinion"],
  },
  {
    triggers: [
      "due diligence", "diligence", "transaction services", "quality of earnings",
      "qoe", "vendor dd",
    ],
    departments: ["Transaction Services", "Due Diligence", "Advisory"],
    keywords: ["due diligence", "quality of earnings", "transaction services"],
  },
  {
    triggers: ["project finance", "infrastructure", "ppp", "greenfield"],
    departments: ["Project Finance", "Infrastructure"],
    keywords: ["project finance", "infrastructure"],
  },
];

/**
 * Desk names that are the SAME desk written differently. Kept separate from
 * the playbook: `department` names a desk, so it must expand to that desk's
 * other spellings only. Routing it through the playbook would turn
 * `department: "DCM"` into the whole debt union (LevFin, Private Credit,
 * Structured Finance…) and rank those equally with the desk actually asked
 * for. Deal-level fan-out is what `deal_type` is for.
 */
const DEPARTMENT_SYNONYMS: Record<string, string[]> = {
  "m and a": ["M&A", "Mergers & Acquisitions"],
  "mergers and acquisitions": ["M&A", "Mergers & Acquisitions"],
  dcm: ["DCM", "Debt Capital Markets"],
  "debt capital markets": ["DCM", "Debt Capital Markets"],
  ecm: ["ECM", "Equity Capital Markets"],
  "equity capital markets": ["ECM", "Equity Capital Markets"],
  levfin: ["LevFin", "Leveraged Finance"],
  "leveraged finance": ["LevFin", "Leveraged Finance"],
  "financial sponsors": ["Financial Sponsors", "Sponsors", "Sponsor Coverage"],
  sponsors: ["Financial Sponsors", "Sponsors", "Sponsor Coverage"],
  fig: ["FIG", "Financial Institutions Group"],
  "financial institutions group": ["FIG", "Financial Institutions Group"],
  tmt: ["TMT", "Technology, Media & Telecom"],
  "transaction services": ["Transaction Services", "TS", "Due Diligence"],
};

/** Shorthand a user is likely to type for a seniority band. */
const SENIORITY_SYNONYMS: Record<string, string[]> = {
  md: ["Managing Director", "MD", "Partner", "Head"],
  "managing director": ["Managing Director", "MD", "Partner", "Head"],
  partner: ["Partner", "Managing Director", "Head"],
  ed: ["Executive Director", "ED"],
  "executive director": ["Executive Director", "ED"],
  svp: ["Senior Vice President", "SVP"],
  vp: ["Vice President", "VP"],
  "vice president": ["Vice President", "VP"],
  director: ["Director"],
  associate: ["Associate"],
  analyst: ["Analyst"],
  head: ["Head", "Managing Director", "Partner"],
  senior: ["Managing Director", "Partner", "Head", "Executive Director", "Director"],
  junior: ["Associate", "Analyst"],
};

export interface DealExpertise {
  /** Desk names to look for in `department`. */
  departments: string[];
  /** Terms to look for in `specialization` / `title` / `bio`. */
  keywords: string[];
  /** True when the input matched a playbook entry rather than falling through. */
  recognized: boolean;
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9+\-/ ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A trigger hits when it appears at a word start in the normalized input. */
function matchesTrigger(normalized: string, trigger: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${escapeRegex(trigger)}`).test(normalized);
}

/**
 * Translate a described mandate ("LBO", "sell-side carve-out", "refinancing")
 * into the desks and expertise terms that run it. Every matching playbook entry
 * contributes — "pre-IPO growth round" pulls in both ECM and growth desks.
 */
export function expandDealType(value: string): DealExpertise {
  const raw = value.trim();
  if (!raw) return { departments: [], keywords: [], recognized: false };

  const normalized = normalize(raw);
  const hits = PLAYBOOK.filter((entry) =>
    entry.triggers.some((trigger) => matchesTrigger(normalized, normalize(trigger))),
  );

  if (hits.length === 0) {
    return { departments: [raw], keywords: [raw], recognized: false };
  }

  return {
    departments: dedupe(hits.flatMap((entry) => entry.departments)),
    keywords: dedupe([raw, ...hits.flatMap((entry) => entry.keywords)]),
    recognized: true,
  };
}

/**
 * Desk names equivalent to the one asked for. "DCM" and "Debt Capital Markets"
 * are the same desk written two ways, and a caller filtering on either should
 * find both. Only spellings of that same desk — a desk ask stays a desk ask;
 * use `expandDealType` when the user described a mandate instead.
 */
export function expandDepartment(value: string): string[] {
  const raw = value.trim();
  if (!raw) return [];
  const synonyms = DEPARTMENT_SYNONYMS[normalize(raw)];
  return synonyms ? dedupe([raw, ...synonyms]) : [raw];
}

/** Seniority labels equivalent to the one asked for ("MD" → "Managing Director"). */
export function expandSeniority(value: string): string[] {
  const raw = value.trim();
  if (!raw) return [];
  const synonyms = SENIORITY_SYNONYMS[normalize(raw)];
  return synonyms ? dedupe([raw, ...synonyms]) : [raw];
}
