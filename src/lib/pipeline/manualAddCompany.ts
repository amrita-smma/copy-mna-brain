/**
 * Validation and payload building for the Pipeline "Add Company → Manual"
 * form. Pure and dependency-light (no DB, no Next.js) so the form component
 * stays thin and the rules are unit-tested.
 *
 * The form creates the company straight at L0. `CompanyService.createFromDTO`
 * does not run the L0 required-field gate on create, so the form enforces it
 * here: every field in `L0_REQUIRED_FIELDS` the user supplies is required,
 * plus the fields the add-company brief asks for (HQ country, what the company
 * does). `entered_by` is stamped by `POST /api/companies` from the session.
 */
import { countryCode } from '@/lib/countryFlag';
import { DEFAULT_DEAL_TYPE, type DealType } from '@/lib/companies/dealTypes';
import { getMissingL0Fields } from '@/lib/companies/l0Requirements';
import { FIRST_STAGE_KEY } from '@/lib/pipeline/stages';

export interface ManualCompanyForm {
  name: string;
  segment: string;
  geography: string;
  company_focus: string;
  website: string;
  ownership: string;
  source: '' | 'inbound' | 'outbound';
  deal_type: DealType;
  banker: string;
  fiscal_year: string;
  revenue_usd_mn: string;
  ebitda_usd_mn: string;
  ev_usd_mn: string;
  comments: string;
  remarks: string;
  thesis_content: string;
  watchlist_id: string;
  watchlist_status: string;
}

export type ManualCompanyField = keyof ManualCompanyForm;

/** Most recent completed fiscal year — the default for the financials row. */
export function defaultFiscalYear(now: Date = new Date()): number {
  return now.getUTCFullYear() - 1;
}

export function emptyManualCompanyForm(now: Date = new Date()): ManualCompanyForm {
  return {
    name: '',
    segment: '',
    geography: '',
    company_focus: '',
    website: '',
    ownership: '',
    source: '',
    deal_type: DEFAULT_DEAL_TYPE,
    banker: '',
    fiscal_year: String(defaultFiscalYear(now)),
    revenue_usd_mn: '',
    ebitda_usd_mn: '',
    ev_usd_mn: '',
    comments: '',
    remarks: '',
    thesis_content: '',
    watchlist_id: '',
    watchlist_status: '',
  };
}

/** The flat `CompanyDTOInput` sent to `POST /api/companies`. */
export interface ManualCompanyPayload {
  target: string;
  segment: string;
  geography: string;
  company_focus: string;
  website: string | null;
  ownership: string | null;
  source: 'inbound' | 'outbound';
  deal_type: DealType;
  banker: string | null;
  comments: string | null;
  remarks: string | null;
  thesis_content: string | null;
  watchlist_id: number | null;
  watchlist_status: string | null;
  pipeline_stage: string;
  status: 'active';
}

/** One row for `PUT /api/companies/:id/financials`; only supplied figures are set. */
export interface ManualFinancialsRow {
  fiscal_year: number;
  revenue_usd_mn?: number;
  ebitda_usd_mn?: number;
  ev_usd_mn?: number;
}

export type ManualCompanyResult =
  | { status: 'valid'; company: ManualCompanyPayload; financials: ManualFinancialsRow | null }
  | { status: 'invalid'; errors: Partial<Record<ManualCompanyField, string>>; formError?: string };

const MIN_FISCAL_YEAR = 1990;
const MAX_FISCAL_YEAR = 2100;

const orNull = (v: string): string | null => {
  const t = v.trim();
  return t.length > 0 ? t : null;
};

/** `""` → undefined (not given); `"1,250.5"` → 1250.5; garbage → NaN. */
function parseAmount(v: string): number | undefined {
  const t = v.replace(/,/g, '').trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : Number.NaN;
}

export function validateManualCompany(form: ManualCompanyForm): ManualCompanyResult {
  const errors: Partial<Record<ManualCompanyField, string>> = {};

  const name = form.name.trim();
  const segment = form.segment.trim();
  const geography = form.geography.trim();
  const companyFocus = form.company_focus.trim();
  const banker = form.banker.trim();

  if (!name) errors.name = 'Company name is required.';
  if (!segment) errors.segment = 'Segment is required.';
  if (!geography) {
    errors.geography = 'HQ country is required.';
  } else if (!countryCode(geography)) {
    errors.geography = 'Enter one country in English, not a region or a list.';
  }
  if (!companyFocus) errors.company_focus = 'Describe what the company does.';
  if (!form.source) errors.source = 'Choose inbound or outbound.';
  if (form.source === 'inbound' && !banker) {
    errors.banker = 'Inbound deals need a banker.';
  }

  const figures = {
    revenue_usd_mn: parseAmount(form.revenue_usd_mn),
    ebitda_usd_mn: parseAmount(form.ebitda_usd_mn),
    ev_usd_mn: parseAmount(form.ev_usd_mn),
  };
  for (const [key, value] of Object.entries(figures) as [keyof typeof figures, number | undefined][]) {
    if (Number.isNaN(value)) errors[key] = 'Enter a number in USD mn.';
  }
  const hasFigures = Object.values(figures).some((v) => v !== undefined);
  const fiscalYear = Number(form.fiscal_year.trim());
  if (
    hasFigures &&
    (!Number.isInteger(fiscalYear) || fiscalYear < MIN_FISCAL_YEAR || fiscalYear > MAX_FISCAL_YEAR)
  ) {
    errors.fiscal_year = 'Enter the fiscal year these figures are for.';
  }

  const watchlistIdText = form.watchlist_id.trim();
  const watchlistId = watchlistIdText === '' ? null : Number(watchlistIdText);
  if (watchlistId !== null && !Number.isSafeInteger(watchlistId)) {
    errors.watchlist_id = 'Watchlist ID must be a whole number.';
  }

  if (Object.keys(errors).length > 0) return { status: 'invalid', errors };

  const company: ManualCompanyPayload = {
    target: name,
    segment,
    geography,
    company_focus: companyFocus,
    website: orNull(form.website),
    ownership: orNull(form.ownership),
    source: form.source as 'inbound' | 'outbound',
    deal_type: form.deal_type,
    // Banker is an inbound-only field; drop a value left over from toggling.
    banker: form.source === 'inbound' ? banker : null,
    comments: orNull(form.comments),
    remarks: orNull(form.remarks),
    thesis_content: orNull(form.thesis_content),
    watchlist_id: watchlistId,
    watchlist_status: orNull(form.watchlist_status),
    pipeline_stage: FIRST_STAGE_KEY,
    status: 'active',
  };

  // Safety net: if L0 gains a requirement this form doesn't collect, block
  // rather than insert an L0 row that fails the gate. `entered_by` is stamped
  // server-side, so it is treated as satisfied here.
  const missing = getMissingL0Fields({ ...company, entered_by: 'session-user' });
  if (missing.length > 0) {
    return { status: 'invalid', errors: {}, formError: `Missing required fields: ${missing.join(', ')}` };
  }

  let financials: ManualFinancialsRow | null = null;
  if (hasFigures) {
    financials = { fiscal_year: fiscalYear };
    for (const [key, value] of Object.entries(figures) as [keyof typeof figures, number | undefined][]) {
      if (value !== undefined) financials[key] = value;
    }
  }

  return { status: 'valid', company, financials };
}
