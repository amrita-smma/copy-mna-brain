/**
 * The canonical `deal_type` vocabulary — the ONE place a deal type is written
 * down.
 *
 * `companies.deal_type` is a Postgres enum, so this list and the
 * `pgEnum("deal_type", …)` declaration in `@/lib/db/schema` must agree; adding
 * a value means an `ALTER TYPE … ADD VALUE` migration as well as an entry here.
 * `dealTypes.test.ts` asserts the two lists match so a schema change that
 * forgets this file fails the suite.
 *
 * Deliberately dependency-free — it is imported by client components (the
 * pipeline tables and the edit dialogs), by services, by repositories and by
 * agent tools, so it must not drag the Drizzle schema or the LangChain stack
 * into the client bundle.
 */

/**
 * Every deal type, in display order: the two principal-side positions the firm
 * takes, then the public-market and financing mandates, then the advisory ones.
 * The first two are the original values and must stay first — the pipeline
 * tables and the seed fixtures assume `majority` is the default.
 */
export const DEAL_TYPES = [
  // Principal side — the firm takes a position.
  "majority",
  "minority",
  "public_market",
  // Capital markets / financing.
  "bond_issuance",
  "ipo",
  "follow_on_offering",
  "private_placement",
  "equity_crowdfunding",
  "debt_financing",
  // Advisory mandates.
  "ma_advisory",
  "restructuring",
  "joint_venture",
] as const;

export type DealType = (typeof DEAL_TYPES)[number];

/** The default applied to a manually added company and by the DB column. */
export const DEFAULT_DEAL_TYPE: DealType = "majority";

/**
 * Human labels. Keyed by `DealType` so a new enum value fails the build until
 * it is given one — never widen this to `Record<string, string>`.
 */
export const DEAL_TYPE_LABEL: Record<DealType, string> = {
  majority: "Majority",
  minority: "Minority",
  public_market: "Public Market Investing",
  bond_issuance: "Bond Issuance",
  ipo: "IPO",
  follow_on_offering: "Follow-on Offering",
  private_placement: "Private Placement",
  equity_crowdfunding: "Equity Crowdfunding",
  debt_financing: "Debt Financing",
  ma_advisory: "M&A Advisory",
  restructuring: "Restructuring",
  joint_venture: "Joint Venture",
};

/** The `{ value, label }` pairs a `<Select>` renders, in display order. */
export const DEAL_TYPE_OPTIONS: ReadonlyArray<{ value: DealType; label: string }> =
  DEAL_TYPES.map((value) => ({ value, label: DEAL_TYPE_LABEL[value] }));

/** Narrow an untrusted value (a DB column, a form field, a tool argument). */
export function isDealType(value: unknown): value is DealType {
  return typeof value === "string" && (DEAL_TYPES as readonly string[]).includes(value);
}

/**
 * Coerce free-text agent/user input to a deal type. Trims, lowercases and
 * accepts a few spellings a human or an LLM reasonably produces for the
 * multi-word values ("Public Market", "M&A Advisory", "follow-on") — returns
 * `undefined` when nothing matches, so callers can report the error.
 */
export function normalizeDealType(value: string | null | undefined): DealType | undefined {
  if (typeof value !== "string") return undefined;
  const key = value.trim().toLowerCase().replace(/[\s&/-]+/g, "_").replace(/_+/g, "_");
  if (isDealType(key)) return key;
  return DEAL_TYPE_ALIASES[key];
}

/**
 * Spellings `normalizeDealType` accepts beyond the enum values themselves,
 * after its whitespace/punctuation collapse. Keep this small: it exists so an
 * agent writing "public market investing" or "M&A advisory" lands on the right
 * value, not to invent a second vocabulary.
 */
const DEAL_TYPE_ALIASES: Record<string, DealType> = {
  public_market_investing: "public_market",
  public_markets: "public_market",
  listed_equity: "public_market",
  bond: "bond_issuance",
  bonds: "bond_issuance",
  initial_public_offering: "ipo",
  follow_on: "follow_on_offering",
  follow_on_equity_offering: "follow_on_offering",
  secondary_offering: "follow_on_offering",
  m_a_advisory: "ma_advisory",
  m_and_a_advisory: "ma_advisory",
  jv: "joint_venture",
  crowdfunding: "equity_crowdfunding",
  equity_crowd_funding: "equity_crowdfunding",
};

/**
 * Render a stored `deal_type` for display. Unknown values (a row written
 * before this build, or a value added to the DB enum but not yet to
 * `DEAL_TYPE_LABEL`) fall back to a title-cased form of the raw value rather
 * than disappearing.
 */
export function formatDealType(value: string | null | undefined): string | null {
  if (!value) return null;
  if (isDealType(value)) return DEAL_TYPE_LABEL[value];
  return value
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((word) => `${word[0].toUpperCase()}${word.slice(1)}`)
    .join(" ");
}
