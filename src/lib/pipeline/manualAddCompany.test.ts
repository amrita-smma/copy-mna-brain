import { describe, it, expect } from 'vitest';
import {
  defaultFiscalYear,
  emptyManualCompanyForm,
  validateManualCompany,
  type ManualCompanyForm,
} from './manualAddCompany';

const NOW = new Date('2026-10-05T00:00:00Z');

function form(overrides: Partial<ManualCompanyForm> = {}): ManualCompanyForm {
  return {
    ...emptyManualCompanyForm(NOW),
    name: 'Acme Corp',
    segment: 'Semiconductor',
    geography: 'Indonesia',
    company_focus: 'Makes CMP slurry for wafer fabs.',
    source: 'outbound',
    ...overrides,
  };
}

describe('defaultFiscalYear', () => {
  it('is the last completed calendar year', () => {
    expect(defaultFiscalYear(NOW)).toBe(2025);
  });
});

describe('emptyManualCompanyForm', () => {
  it('starts with no source chosen, majority deal type and last year as the fiscal year', () => {
    const empty = emptyManualCompanyForm(NOW);
    expect(empty.source).toBe('');
    expect(empty.deal_type).toBe('majority');
    expect(empty.fiscal_year).toBe('2025');
  });
});

describe('validateManualCompany', () => {
  it('flags every required field on an empty form', () => {
    const result = validateManualCompany(emptyManualCompanyForm(NOW));
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(Object.keys(result.errors).sort()).toEqual(
      ['company_focus', 'geography', 'name', 'segment', 'source'].sort(),
    );
  });

  it('rejects a region or a list of countries as the HQ country', () => {
    for (const geography of ['Asia Pacific', 'Malaysia, Singapore']) {
      const result = validateManualCompany(form({ geography }));
      expect(result.status).toBe('invalid');
      if (result.status !== 'invalid') continue;
      expect(result.errors.geography).toMatch(/one country/);
    }
  });

  it('accepts country aliases like USA as entered', () => {
    const result = validateManualCompany(form({ geography: 'USA' }));
    expect(result.status).toBe('valid');
    if (result.status !== 'valid') return;
    expect(result.company.geography).toBe('USA');
  });

  it('requires a banker for inbound deals but not outbound ones', () => {
    const inbound = validateManualCompany(form({ source: 'inbound' }));
    expect(inbound.status).toBe('invalid');
    if (inbound.status === 'invalid') expect(inbound.errors.banker).toBeDefined();

    expect(validateManualCompany(form({ source: 'inbound', banker: 'Morgan Stanley' })).status).toBe('valid');
    expect(validateManualCompany(form({ source: 'outbound' })).status).toBe('valid');
  });

  it('drops a banker left over from switching an inbound deal to outbound', () => {
    const result = validateManualCompany(form({ source: 'outbound', banker: 'Morgan Stanley' }));
    expect(result.status).toBe('valid');
    if (result.status === 'valid') expect(result.company.banker).toBeNull();
  });

  it('builds an L0 active payload with trimmed text and nulls for blank optionals', () => {
    const result = validateManualCompany(
      form({
        name: '  Acme Corp  ',
        website: ' https://acme.example ',
        ownership: '',
        watchlist_id: '42',
        watchlist_status: '  ',
      }),
    );
    expect(result.status).toBe('valid');
    if (result.status !== 'valid') return;
    expect(result.company).toEqual({
      target: 'Acme Corp',
      segment: 'Semiconductor',
      geography: 'Indonesia',
      company_focus: 'Makes CMP slurry for wafer fabs.',
      website: 'https://acme.example',
      ownership: null,
      source: 'outbound',
      deal_type: 'majority',
      banker: null,
      comments: null,
      remarks: null,
      thesis_content: null,
      watchlist_id: 42,
      watchlist_status: null,
      pipeline_stage: 'L0',
      status: 'active',
    });
    expect(result.financials).toBeNull();
  });

  it('returns a financials row with only the figures supplied, parsing thousands separators', () => {
    const result = validateManualCompany(
      form({ fiscal_year: '2025', revenue_usd_mn: '1,250.5', ev_usd_mn: '80' }),
    );
    expect(result.status).toBe('valid');
    if (result.status !== 'valid') return;
    expect(result.financials).toEqual({ fiscal_year: 2025, revenue_usd_mn: 1250.5, ev_usd_mn: 80 });
  });

  it('rejects non-numeric figures and a missing fiscal year when figures are given', () => {
    const result = validateManualCompany(
      form({ fiscal_year: '', revenue_usd_mn: 'ten', ebitda_usd_mn: '5' }),
    );
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.errors.revenue_usd_mn).toBeDefined();
    expect(result.errors.fiscal_year).toBeDefined();
    expect(result.errors.ebitda_usd_mn).toBeUndefined();
  });

  it('ignores a blank fiscal year when no figures are given', () => {
    expect(validateManualCompany(form({ fiscal_year: '' })).status).toBe('valid');
  });

  it('rejects a non-integer watchlist ID', () => {
    const result = validateManualCompany(form({ watchlist_id: '4.5' }));
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.errors.watchlist_id).toBeDefined();
  });
});
