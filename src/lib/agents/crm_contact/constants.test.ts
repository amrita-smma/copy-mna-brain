import { describe, expect, it } from 'vitest';
import {
  CRM_COMPANY_CONTACTS_AGENT_NAME,
  domainFromWebsite,
  CRM_CONTACT_AGENT_NAME,
  isCrmCompanyContactsAgent,
  CRM_CONTACT_WRITABLE_FIELDS,
  isCrmContactAgent,
  missingProfileFields,
  partnershipRoleRank,
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

describe('isCrmCompanyContactsAgent', () => {
  it('matches only the company-contacts agent_name, distinct from the correspondent one', () => {
    expect(CRM_COMPANY_CONTACTS_AGENT_NAME).not.toBe(CRM_CONTACT_AGENT_NAME);
    expect(isCrmCompanyContactsAgent(CRM_COMPANY_CONTACTS_AGENT_NAME)).toBe(true);
    expect(isCrmCompanyContactsAgent(CRM_CONTACT_AGENT_NAME)).toBe(false);
    expect(isCrmCompanyContactsAgent(null)).toBe(false);
    expect(isCrmContactAgent(CRM_COMPANY_CONTACTS_AGENT_NAME)).toBe(false);
  });
});

describe('partnershipRoleRank', () => {
  it('ranks CEO above commercial chiefs above BD leads above BD managers above other execs', () => {
    const ranks = [
      'Chief Executive Officer',
      'Chief Commercial Officer',
      'VP Business Development',
      'Business Development Manager',
      'Country Manager',
      'CFO',
    ].map(partnershipRoleRank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('puts a BD manager in the BD tier, not the generic-manager tier', () => {
    expect(partnershipRoleRank('Business Development Manager')).toBeLessThan(
      partnershipRoleRank('General Manager'),
    );
  });

  it('does not lift a non-commercial "Head of" above the C-level tier', () => {
    expect(partnershipRoleRank('Head of Engineering')).toBeGreaterThan(partnershipRoleRank('CFO'));
    expect(partnershipRoleRank('Head of Partnerships')).toBeLessThan(partnershipRoleRank('CFO'));
  });

  it('puts a missing or unrecognised title last', () => {
    expect(partnershipRoleRank(null)).toBe(partnershipRoleRank('Software Engineer'));
    expect(partnershipRoleRank('CEO')).toBeLessThan(partnershipRoleRank(''));
  });
});

describe('domainFromWebsite', () => {
  it('strips scheme, www and path', () => {
    expect(domainFromWebsite('https://www.acme.co.id/about')).toBe('acme.co.id');
    expect(domainFromWebsite('acme.com')).toBe('acme.com');
  });

  it('refuses social and site-builder hosts, which must never be claimed as a company domain', () => {
    expect(domainFromWebsite('https://www.linkedin.com/company/acme')).toBeUndefined();
    expect(domainFromWebsite('facebook.com/acme')).toBeUndefined();
    expect(domainFromWebsite('acme.wixsite.com/home')).toBeUndefined();
  });

  it('returns undefined for an empty or unparseable website', () => {
    expect(domainFromWebsite(null)).toBeUndefined();
    expect(domainFromWebsite('   ')).toBeUndefined();
    expect(domainFromWebsite('http://')).toBeUndefined();
    expect(domainFromWebsite('localhost')).toBeUndefined();
  });
});
