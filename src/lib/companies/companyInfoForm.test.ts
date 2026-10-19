import { describe, expect, it } from 'vitest';
import {
  buildCompanyInfoUpdate,
  changedCompanyInfoFields,
  companyInfoFormFrom,
  isoToDateInput,
  type CompanyInfoForm,
} from './companyInfoForm';

const FIRST_STAGE = 'L0';

function form(overrides: Partial<CompanyInfoForm> = {}): CompanyInfoForm {
  return { ...companyInfoFormFrom({}, FIRST_STAGE), ...overrides };
}

describe('isoToDateInput', () => {
  it('returns the YYYY-MM-DD part of an ISO timestamp', () => {
    expect(isoToDateInput('2026-03-04T10:00:00.000Z')).toBe('2026-03-04');
  });

  it('returns an empty string for a missing or invalid value', () => {
    expect(isoToDateInput(null)).toBe('');
    expect(isoToDateInput('not a date')).toBe('');
  });
});

describe('companyInfoFormFrom', () => {
  it('seeds empty strings for unset fields and the fallback stage', () => {
    const f = companyInfoFormFrom({}, FIRST_STAGE);
    expect(f.target).toBe('');
    expect(f.pipeline_stage).toBe(FIRST_STAGE);
    expect(f.is_live).toBe('__auto__');
    expect(f.matched_track_ids).toEqual([]);
  });

  it('carries every field both views edit, including focus, comments, NBO and tracks', () => {
    const f = companyInfoFormFrom(
      {
        target: 'Acme',
        ev_2024: 120.5,
        is_live: false,
        nbo_date: '2026-11-01',
        company_focus: 'Cold chain',
        comments: 'Founder-led',
        matched_track_ids: ['t1'],
      },
      FIRST_STAGE,
    );
    expect(f).toMatchObject({
      target: 'Acme',
      ev_2024: '120.5',
      is_live: 'false',
      nbo_date: '2026-11-01',
      company_focus: 'Cold chain',
      comments: 'Founder-led',
      matched_track_ids: ['t1'],
    });
  });
});

describe('buildCompanyInfoUpdate', () => {
  it('trims text and turns blanks into null', () => {
    const result = buildCompanyInfoUpdate(
      form({ target: '  Acme  ', segment: '   ', company_focus: ' Logistics ' }),
      'inbound',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.update).toMatchObject({ target: 'Acme', segment: null, company_focus: 'Logistics' });
  });

  it('rejects a non-numeric valuation', () => {
    expect(buildCompanyInfoUpdate(form({ ev_2024: 'abc' }), 'inbound')).toEqual({
      ok: false,
      error: 'Valuation must be a number',
    });
  });

  it('rejects an out-of-range stake', () => {
    const result = buildCompanyInfoUpdate(form({ stake: '150%' }), 'inbound');
    expect(result.ok).toBe(false);
  });

  it('maps the live-process choice to true / false / null', () => {
    const pick = (is_live: CompanyInfoForm['is_live']) => {
      const r = buildCompanyInfoUpdate(form({ is_live }), 'inbound');
      return r.ok ? r.update.is_live : 'error';
    };
    expect(pick('true')).toBe(true);
    expect(pick('false')).toBe(false);
    expect(pick('__auto__')).toBeNull();
  });

  it('writes remarks for an inbound deal', () => {
    const r = buildCompanyInfoUpdate(form({ remarks: 'note' }), 'inbound');
    expect(r.ok && r.update.remarks).toBe('note');
  });

  it('leaves remarks alone for an outbound deal (edited in the Market Scanning card)', () => {
    const r = buildCompanyInfoUpdate(form({ remarks: 'note' }), 'outbound');
    expect(r.ok && 'remarks' in r.update).toBe(false);
  });
});

describe('changedCompanyInfoFields', () => {
  it('keeps only the fields the draft changed', () => {
    const seeded = companyInfoFormFrom({ target: 'Acme', segment: 'Logistics' }, FIRST_STAGE);
    const before = buildCompanyInfoUpdate(seeded, 'inbound');
    const after = buildCompanyInfoUpdate({ ...seeded, segment: 'Cold chain' }, 'inbound');
    if (!before.ok || !after.ok) throw new Error('expected valid drafts');
    expect(changedCompanyInfoFields(before.update, after.update)).toEqual({ segment: 'Cold chain' });
  });

  it('never sends a field the host did not load and the user did not touch', () => {
    // Seeded from a row without company_focus: it stays out of the payload.
    const seeded = companyInfoFormFrom({ target: 'Acme' }, FIRST_STAGE);
    const before = buildCompanyInfoUpdate(seeded, 'inbound');
    const after = buildCompanyInfoUpdate({ ...seeded, target: 'Acme Corp' }, 'inbound');
    if (!before.ok || !after.ok) throw new Error('expected valid drafts');
    expect(changedCompanyInfoFields(before.update, after.update)).not.toHaveProperty('company_focus');
  });

  it('compares track lists by value', () => {
    const seeded = companyInfoFormFrom({ matched_track_ids: ['t1'] }, FIRST_STAGE);
    const before = buildCompanyInfoUpdate(seeded, 'inbound');
    const same = buildCompanyInfoUpdate({ ...seeded, matched_track_ids: ['t1'] }, 'inbound');
    const more = buildCompanyInfoUpdate({ ...seeded, matched_track_ids: ['t1', 't2'] }, 'inbound');
    if (!before.ok || !same.ok || !more.ok) throw new Error('expected valid drafts');
    expect(changedCompanyInfoFields(before.update, same.update)).toEqual({});
    expect(changedCompanyInfoFields(before.update, more.update)).toEqual({ matched_track_ids: ['t1', 't2'] });
  });
});
