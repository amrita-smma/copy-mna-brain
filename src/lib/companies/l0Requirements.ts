/**
 * Single source of truth for the fields a company must have before it can
 * enter L0 (the first active pipeline stage).
 *
 * These requirements were previously duplicated in several places — the
 * service-layer validator, the Smart Files approval path, and the review/entry
 * UIs. Everything now derives from `L0_REQUIRED_FIELDS` here so the rules stay
 * in lockstep. This module is intentionally dependency-free (no DB, no Next.js
 * imports) so it can be imported from both server code and client components.
 */

/** The subset of company fields consulted when validating L0 entry. */
export interface L0CompanyInput {
  target?: string | null;
  project_name?: string | null;
  entered_by?: string | null;
  source?: string | null;
  deal_type?: string | null;
  geography?: string | null;
  segment?: string | null;
  banker?: string | null;
  banker_source?: string | null;
}

/** Stable identifier for each requirement — used by UIs to key their inputs. */
export type L0FieldKey =
  | 'name'
  | 'entered_by'
  | 'source'
  | 'deal_type'
  | 'geography'
  | 'segment'
  | 'banker';

export interface L0RequiredField {
  /** Stable key (not shown to users). */
  key: L0FieldKey;
  /** Human-facing label — also what appears in the "missing fields" message. */
  label: string;
  /** True when `company` satisfies this requirement. */
  isSatisfied: (company: L0CompanyInput) => boolean;
}

const filled = (v: string | null | undefined): boolean =>
  typeof v === 'string' && v.trim().length > 0;

/**
 * Canonical, ordered list of L0 requirements. The labels here are the exact
 * strings surfaced to users (in the amber "required to add to L0" boxes and in
 * the `CompanyL0RequirementsError.missingFields` payload).
 */
export const L0_REQUIRED_FIELDS: readonly L0RequiredField[] = [
  {
    key: 'name',
    label: 'Company Name / Project Name',
    isSatisfied: (c) => filled(c.target) || filled(c.project_name),
  },
  {
    key: 'entered_by',
    label: 'Entered By',
    isSatisfied: (c) => filled(c.entered_by),
  },
  {
    key: 'source',
    label: 'Deal Type: Inbound/Outbound',
    isSatisfied: (c) => filled(c.source),
  },
  {
    key: 'deal_type',
    label: 'Deal Type: Majority/Minority',
    isSatisfied: (c) => filled(c.deal_type),
  },
  {
    key: 'geography',
    label: 'Geo',
    isSatisfied: (c) => filled(c.geography),
  },
  {
    key: 'segment',
    label: 'Sector',
    isSatisfied: (c) => filled(c.segment),
  },
  {
    key: 'banker',
    label: 'Banker',
    // Outbound deals originate from us, so they don't require a banker; inbound
    // deals must name a banker (or a banker source as a fallback).
    isSatisfied: (c) =>
      c.source === 'outbound' || filled(c.banker) || filled(c.banker_source),
  },
];

/**
 * Returns the labels of every L0 requirement `company` does not yet satisfy.
 * An empty array means the company is ready for L0.
 */
export function getMissingL0Fields(company: L0CompanyInput): string[] {
  return L0_REQUIRED_FIELDS.filter((f) => !f.isSatisfied(company)).map(
    (f) => f.label,
  );
}
