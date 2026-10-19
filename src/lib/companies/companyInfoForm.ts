/**
 * The Company Information edit form shared by the full company page
 * (`CompanyDetail.tsx`) and the pipeline dialog (`CompanyDetailDialog.tsx`):
 * the draft shape, how it is seeded from a company, and how a draft becomes
 * the `PATCH /api/companies` payload. Pure (no React, no fetch) so both views
 * save exactly the same fields and the rules are unit-tested.
 */
import { normalizeStake } from '@/lib/stake';

/** The company fields the Company Information card reads and edits. */
export interface CompanyInfoSource {
  target?: string | null;
  project_name?: string | null;
  website?: string | null;
  geography?: string | null;
  source?: string | null;
  ownership?: string | null;
  segment?: string | null;
  pipeline_stage?: string | null;
  ev_2024?: number | null;
  deal_type?: string | null;
  last_activity_at?: string | null;
  workflow_status?: string | null;
  banker?: string | null;
  advisor?: string | null;
  nbo_date?: string | null;
  is_live?: boolean | null;
  doc_type?: string | null;
  stake?: string | null;
  deal_size?: string | null;
  key_rationale?: string | null;
  remarks?: string | null;
  deal_sponsor?: string | null;
  deal_captain?: string | null;
  entered_by?: string | null;
  matched_track_ids?: string[] | null;
  company_focus?: string | null;
  comments?: string | null;
}

/** `is_live` as a select value: `__auto__` = derive from the advisor. */
export type IsLiveChoice = '__auto__' | 'true' | 'false';

/** The in-progress draft. Every text field is a string ('' = empty). */
export interface CompanyInfoForm {
  target: string;
  project_name: string;
  website: string;
  geography: string;
  source: string;
  ownership: string;
  segment: string;
  pipeline_stage: string;
  ev_2024: string;
  deal_type: string;
  last_activity_at: string; // YYYY-MM-DD
  workflow_status: string;
  banker: string;
  advisor: string;
  nbo_date: string; // YYYY-MM-DD
  is_live: IsLiveChoice;
  doc_type: string;
  stake: string;
  deal_size: string;
  key_rationale: string;
  remarks: string;
  deal_sponsor: string;
  deal_captain: string;
  entered_by: string;
  matched_track_ids: string[];
  company_focus: string;
  comments: string;
}

/** An ISO timestamp or date as a `<input type="date">` value ('' when unset/invalid). */
export function isoToDateInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toISOString().split('T')[0];
}

/** Seed a draft from the company as currently shown. */
export function companyInfoFormFrom(
  company: CompanyInfoSource,
  fallbackStage: string,
): CompanyInfoForm {
  return {
    target: company.target ?? '',
    project_name: company.project_name ?? '',
    website: company.website ?? '',
    geography: company.geography ?? '',
    source: company.source ?? '',
    ownership: company.ownership ?? '',
    segment: company.segment ?? '',
    pipeline_stage: company.pipeline_stage ?? fallbackStage,
    ev_2024: company.ev_2024 != null ? String(company.ev_2024) : '',
    deal_type: company.deal_type ?? '',
    last_activity_at: isoToDateInput(company.last_activity_at),
    workflow_status: company.workflow_status ?? '',
    banker: company.banker ?? '',
    advisor: company.advisor ?? '',
    nbo_date: isoToDateInput(company.nbo_date),
    is_live: company.is_live == null ? '__auto__' : company.is_live ? 'true' : 'false',
    doc_type: company.doc_type ?? '',
    stake: company.stake ?? '',
    deal_size: company.deal_size ?? '',
    key_rationale: company.key_rationale ?? '',
    remarks: company.remarks ?? '',
    deal_sponsor: company.deal_sponsor ?? '',
    deal_captain: company.deal_captain ?? '',
    entered_by: company.entered_by ?? '',
    matched_track_ids: company.matched_track_ids ?? [],
    company_focus: company.company_focus ?? '',
    comments: company.comments ?? '',
  };
}

/** The `PATCH /api/companies` body a saved draft produces. */
export type CompanyInfoUpdate = Record<string, string | number | boolean | string[] | null>;

export type CompanyInfoUpdateResult =
  | { ok: true; update: CompanyInfoUpdate }
  | { ok: false; error: string };

const textOrNull = (v: string): string | null => v.trim() || null;

/**
 * Validate a draft and build the update payload. `source` is the company's
 * *stored* source: an outbound deal's remarks are edited in the AI Market
 * Scanning Remarks card, so the form only writes `remarks` for inbound deals.
 */
export function buildCompanyInfoUpdate(
  form: CompanyInfoForm,
  storedSource: string | null | undefined,
): CompanyInfoUpdateResult {
  const evNum = form.ev_2024.trim() === '' ? null : Number(form.ev_2024);
  if (evNum !== null && Number.isNaN(evNum)) {
    return { ok: false, error: 'Valuation must be a number' };
  }
  const stake = normalizeStake(form.stake);
  if ('error' in stake) return { ok: false, error: stake.error };

  return {
    ok: true,
    update: {
      target: textOrNull(form.target),
      project_name: textOrNull(form.project_name),
      website: textOrNull(form.website),
      geography: textOrNull(form.geography),
      source: form.source || null,
      ownership: form.ownership || null,
      segment: textOrNull(form.segment),
      pipeline_stage: form.pipeline_stage,
      ev_2024: evNum,
      deal_type: form.deal_type || null,
      last_activity_at: form.last_activity_at
        ? new Date(form.last_activity_at).toISOString()
        : null,
      workflow_status: textOrNull(form.workflow_status),
      banker: textOrNull(form.banker),
      advisor: textOrNull(form.advisor),
      nbo_date: form.nbo_date || null,
      is_live: form.is_live === '__auto__' ? null : form.is_live === 'true',
      doc_type: form.doc_type || null,
      stake: stake.value,
      deal_size: textOrNull(form.deal_size),
      key_rationale: textOrNull(form.key_rationale),
      ...(storedSource !== 'outbound' ? { remarks: textOrNull(form.remarks) } : {}),
      deal_sponsor: textOrNull(form.deal_sponsor),
      deal_captain: textOrNull(form.deal_captain),
      entered_by: textOrNull(form.entered_by),
      matched_track_ids: form.matched_track_ids,
      company_focus: textOrNull(form.company_focus),
      comments: textOrNull(form.comments),
    },
  };
}

/**
 * Keep only the fields `after` changes relative to `before` (both built by
 * `buildCompanyInfoUpdate`). Saving just what the user touched means a host
 * that seeded the form from a partial row (e.g. a pipeline table row that
 * lacks Company Focus) can never blank a field it never loaded.
 */
export function changedCompanyInfoFields(
  before: CompanyInfoUpdate,
  after: CompanyInfoUpdate,
): CompanyInfoUpdate {
  const changed: CompanyInfoUpdate = {};
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(value)) changed[key] = value;
  }
  return changed;
}
