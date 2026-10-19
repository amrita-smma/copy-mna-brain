/**
 * Single source of truth for the fields a company must have before it can
 * enter the pipeline (its first active stage).
 *
 * These requirements were previously duplicated in several places — the
 * service-layer validator, the Smart Files approval path, and the review/entry
 * UIs. Everything now derives from `PIPELINE_REQUIRED_FIELDS` here so the rules stay
 * in lockstep. This module is intentionally dependency-free (no DB, no Next.js
 * imports) so it can be imported from both server code and client components.
 *
 * Which of these fields are enforced is configurable per workspace (Pipeline
 * Settings → Required Fields, stored in `workspaces.pipeline_required_fields`). An
 * unconfigured workspace enforces all of them — the original rules.
 */

/** The subset of company fields consulted when validating pipeline entry. */
export interface PipelineEntryCompanyInput {
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
export type PipelineFieldKey =
  | 'name'
  | 'entered_by'
  | 'source'
  | 'deal_type'
  | 'geography'
  | 'segment'
  | 'banker';

export interface PipelineRequiredField {
  /** Stable key (not shown to users). */
  key: PipelineFieldKey;
  /** Human-facing label — also what appears in the "missing fields" message. */
  label: string;
  /** Short explanation shown beside the toggle in Pipeline Settings. */
  hint: string;
  /** True when `company` satisfies this requirement. */
  isSatisfied: (company: PipelineEntryCompanyInput) => boolean;
}

const filled = (v: string | null | undefined): boolean =>
  typeof v === 'string' && v.trim().length > 0;

/**
 * Canonical, ordered list of pipeline-entry requirements. The labels here are
 * the exact strings surfaced to users (in the amber "required fields" boxes and in
 * the `CompanyPipelineRequirementsError.missingFields` payload).
 */
export const PIPELINE_REQUIRED_FIELDS: readonly PipelineRequiredField[] = [
  {
    key: 'name',
    label: 'Company Name / Project Name',
    hint: "Either the company's name or its project codename. Always required.",
    isSatisfied: (c) => filled(c.target) || filled(c.project_name),
  },
  {
    key: 'entered_by',
    label: 'Entered By',
    hint: 'Who brought the deal in. Defaults to the person promoting it.',
    isSatisfied: (c) => filled(c.entered_by),
  },
  {
    key: 'source',
    label: 'Deal Type: Inbound/Outbound',
    hint: 'Whether the deal is inbound or outbound.',
    isSatisfied: (c) => filled(c.source),
  },
  {
    key: 'deal_type',
    label: 'Deal Type',
    hint: 'Majority, minority, or another deal type.',
    isSatisfied: (c) => filled(c.deal_type),
  },
  {
    key: 'geography',
    label: 'Geo',
    hint: "The company's HQ country.",
    isSatisfied: (c) => filled(c.geography),
  },
  {
    key: 'segment',
    label: 'Sector',
    hint: "The company's sector or segment.",
    isSatisfied: (c) => filled(c.segment),
  },
  {
    key: 'banker',
    label: 'Banker',
    hint: 'The banker on the deal. Inbound deals only; outbound never needs one.',
    // Outbound deals originate from us, so they don't require a banker; inbound
    // deals must name a banker (or a banker source as a fallback).
    isSatisfied: (c) =>
      c.source === 'outbound' || filled(c.banker) || filled(c.banker_source),
  },
];

/** Every requirement key, in canonical order. */
export const PIPELINE_FIELD_KEYS: readonly PipelineFieldKey[] = PIPELINE_REQUIRED_FIELDS.map((f) => f.key);

/**
 * Keys a workspace cannot switch off. A company with neither a name nor a
 * project codename is unaddressable in every list, picker and export.
 */
export const ALWAYS_REQUIRED_PIPELINE_FIELD_KEYS: readonly PipelineFieldKey[] = ['name'];

/** What an unconfigured workspace enforces: every field (the original rules). */
export const DEFAULT_PIPELINE_REQUIRED_FIELD_KEYS: readonly PipelineFieldKey[] = PIPELINE_FIELD_KEYS;

export function isPipelineFieldKey(value: unknown): value is PipelineFieldKey {
  return typeof value === 'string' && (PIPELINE_FIELD_KEYS as readonly string[]).includes(value);
}

/**
 * Turn a stored `workspaces.pipeline_required_fields` value into the keys to
 * enforce: `null` → the default (every field); otherwise the known keys in
 * canonical order, deduped, always including the locked ones. Unknown keys
 * (e.g. a field since removed from the product) are ignored.
 */
export function normalizePipelineRequiredFieldKeys(
  value: readonly string[] | null | undefined,
): PipelineFieldKey[] {
  if (value == null) return [...DEFAULT_PIPELINE_REQUIRED_FIELD_KEYS];
  const chosen = new Set<string>([...value, ...ALWAYS_REQUIRED_PIPELINE_FIELD_KEYS]);
  return PIPELINE_FIELD_KEYS.filter((k) => chosen.has(k));
}

/** True when `keys` enforces the product default (every field). */
export function isDefaultPipelineRequiredFieldConfiguration(
  keys: readonly PipelineFieldKey[],
): boolean {
  const normalized = normalizePipelineRequiredFieldKeys(keys);
  return (
    normalized.length === DEFAULT_PIPELINE_REQUIRED_FIELD_KEYS.length &&
    normalized.every((k, i) => k === DEFAULT_PIPELINE_REQUIRED_FIELD_KEYS[i])
  );
}

/** Raised when a submitted Required Fields payload is malformed. */
export class InvalidPipelineRequiredFieldsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPipelineRequiredFieldsError';
  }
}

/** Validate an untrusted `{ requiredFields: string[] }` PUT body. */
export function parsePipelineRequiredFieldsInput(body: unknown): PipelineFieldKey[] {
  if (!body || typeof body !== 'object') {
    throw new InvalidPipelineRequiredFieldsError('Expected an object body');
  }
  const { requiredFields } = body as { requiredFields?: unknown };
  if (!Array.isArray(requiredFields)) {
    throw new InvalidPipelineRequiredFieldsError('requiredFields must be an array of field keys');
  }
  const unknown = requiredFields.filter((k) => !isPipelineFieldKey(k));
  if (unknown.length > 0) {
    throw new InvalidPipelineRequiredFieldsError(
      `Unknown required field(s): ${unknown.map((k) => String(k)).join(', ')}`,
    );
  }
  return normalizePipelineRequiredFieldKeys(requiredFields as PipelineFieldKey[]);
}

/** The requirement definitions for `requiredKeys`, in canonical order. */
export function pipelineRequiredFieldsFor(
  requiredKeys: readonly PipelineFieldKey[] = DEFAULT_PIPELINE_REQUIRED_FIELD_KEYS,
): PipelineRequiredField[] {
  const keys = new Set(normalizePipelineRequiredFieldKeys(requiredKeys));
  return PIPELINE_REQUIRED_FIELDS.filter((f) => keys.has(f.key));
}

/**
 * Returns the labels of every enforced pipeline requirement `company` does not yet
 * satisfy. `requiredKeys` is the workspace's configuration (default: every
 * field). An empty array means the company is ready to enter the pipeline.
 */
export function getMissingPipelineFields(
  company: PipelineEntryCompanyInput,
  requiredKeys: readonly PipelineFieldKey[] = DEFAULT_PIPELINE_REQUIRED_FIELD_KEYS,
): string[] {
  return pipelineRequiredFieldsFor(requiredKeys)
    .filter((f) => !f.isSatisfied(company))
    .map((f) => f.label);
}
