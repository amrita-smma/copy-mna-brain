import { describe, expect, it } from 'vitest';
import {
  CRM_CONTACT_AGENT_NAME,
  CRM_CONTACT_WRITABLE_FIELDS,
  isCrmContactAgent,
  missingProfileFields,
} from './constants';

describe('CRM_CONTACT_WRITABLE_FIELDS', () => {
  it('excludes name and email — the two fields a wrong match must not touch', () => {
    expect(CRM_CONTACT_WRITABLE_FIELDS).not.toContain('name');
    expect(CRM_CONTACT_WRITABLE_FIELDS).not.toContain('email');
  });

  it('is entirely correspondent_curation columns, so every write is an override', () => {
    // Mirrors OVERLAY_CONTACT_FIELDS in crmService.ts minus name (see above).
    const overlayColumns = [
      'name',
      'title',
      'phone',
      'type',
      'department',
      'specialization',
      'seniority',
      'coverage_region',
      'linkedin_url',
      'bio',
    ];
    for (const field of CRM_CONTACT_WRITABLE_FIELDS) {
      expect(overlayColumns).toContain(field);
    }
  });
});

describe('isCrmContactAgent', () => {
  it('matches only this agent name', () => {
    expect(isCrmContactAgent(CRM_CONTACT_AGENT_NAME)).toBe(true);
    expect(isCrmContactAgent('analysis')).toBe(false);
    expect(isCrmContactAgent('company_card')).toBe(false);
  });

  it('is false for a row with no agent name rather than throwing', () => {
    expect(isCrmContactAgent(null)).toBe(false);
    expect(isCrmContactAgent(undefined)).toBe(false);
  });
});

describe('missingProfileFields', () => {
  it('returns every writable field for a bare record', () => {
    expect(missingProfileFields({})).toEqual([...CRM_CONTACT_WRITABLE_FIELDS]);
  });

  it('treats null and whitespace-only values as missing', () => {
    const missing = missingProfileFields({
      title: null,
      phone: '   ',
      bio: '',
    });
    expect(missing).toContain('title');
    expect(missing).toContain('phone');
    expect(missing).toContain('bio');
  });

  it('omits fields that already hold a value', () => {
    const missing = missingProfileFields({
      title: 'Managing Director',
      department: 'M&A',
    });
    expect(missing).not.toContain('title');
    expect(missing).not.toContain('department');
    expect(missing).toContain('seniority');
  });

  it('returns [] when the record is complete', () => {
    const complete = Object.fromEntries(
      CRM_CONTACT_WRITABLE_FIELDS.map((f) => [f, 'set']),
    );
    expect(missingProfileFields(complete)).toEqual([]);
  });
});
