import { describe, it, expect } from 'vitest';
import {
  L0_REQUIRED_FIELDS,
  getMissingL0Fields,
  type L0CompanyInput,
} from './l0Requirements';

const complete: L0CompanyInput = {
  target: 'Acme Corp',
  entered_by: 'user-uuid',
  source: 'inbound',
  deal_type: 'majority',
  geography: 'Indonesia',
  segment: 'Technology',
  banker: 'Goldman Sachs',
};

describe('getMissingL0Fields', () => {
  it('returns [] when every required field is present (inbound)', () => {
    expect(getMissingL0Fields(complete)).toEqual([]);
  });

  it('accepts project_name in place of target for the name requirement', () => {
    const { target: _target, ...rest } = complete;
    expect(getMissingL0Fields({ ...rest, project_name: 'Project Phoenix' })).toEqual([]);
  });

  it('does not require a banker for outbound deals', () => {
    expect(
      getMissingL0Fields({
        ...complete,
        source: 'outbound',
        banker: null,
        banker_source: null,
      }),
    ).toEqual([]);
  });

  it('accepts banker_source as a fallback for the Banker requirement', () => {
    expect(
      getMissingL0Fields({ ...complete, banker: null, banker_source: 'Some Desk' }),
    ).toEqual([]);
  });

  it('flags Banker for inbound without banker or banker_source', () => {
    expect(
      getMissingL0Fields({ ...complete, banker: null, banker_source: null }),
    ).toContain('Banker');
  });

  it('flags Geo when geography is blank/whitespace', () => {
    expect(getMissingL0Fields({ ...complete, geography: '   ' })).toContain('Geo');
  });

  it('flags Sector when segment is missing', () => {
    expect(getMissingL0Fields({ ...complete, segment: null })).toContain('Sector');
  });

  it('collects all missing labels for an empty company', () => {
    expect(getMissingL0Fields({})).toEqual([
      'Company Name / Project Name',
      'Entered By',
      'Deal Type: Inbound/Outbound',
      'Deal Type',
      'Geo',
      'Sector',
      'Banker',
    ]);
  });
});

describe('L0_REQUIRED_FIELDS', () => {
  it('has unique keys', () => {
    const keys = L0_REQUIRED_FIELDS.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
