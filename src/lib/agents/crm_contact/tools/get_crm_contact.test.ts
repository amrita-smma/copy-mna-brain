import { afterEach, describe, expect, it, vi } from 'vitest';

const findCorrespondentById = vi.fn();
const findEmployerById = vi.fn();
const { getContactInsights, createContainer } = vi.hoisted(() => {
  const getContactInsights = vi.fn();
  return {
    getContactInsights,
    createContainer: vi.fn(() => ({ contactInsightsService: { getContactInsights } })),
  };
});

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: vi.fn(async () => 'ws-1'),
}));
vi.mock('@/lib/repositories', () => ({
  CorrespondentRepository: function CorrespondentRepository() {
    return { findById: findCorrespondentById };
  },
  EmployerRepository: function EmployerRepository() {
    return { findById: findEmployerById };
  },
}));

vi.mock('@/lib/services/container', () => ({ createContainer }));

import { getCrmContact } from './get_crm_contact';

const INSIGHTS = {
  interactions: {
    correspondentId: 'corr-1',
    lastContactAt: '2026-10-14T10:00:00.000Z',
    totalEmailsFromUs: 2,
    totalEmailsFromThem: 3,
    teamMemberCount: 2,
    team: [
      { userId: 'u-1', name: 'Alice', email: 'a@us.example', emailsFromUs: 2, emailsFromThem: 2, lastEmailAt: null },
      { userId: 'u-2', name: 'Bob', email: 'b@us.example', emailsFromUs: 0, emailsFromThem: 1, lastEmailAt: null },
    ],
    hasSyncedData: true,
  },
  relatedCompanies: [],
  deals: [
    { companyId: 'co-1', companyName: 'Acme', role: 'source', origin: 'manual', stage: 'L1', stageLabel: 'L1 · Screening', isDropped: false, linkedAt: '2026-10-01' },
  ],
  scorecard: { correspondentId: 'corr-1', dealsBrought: 1, dealsInvolved: 0, reachedL1: 1, conversion: 1, stageBreakdown: [], hasDealLinks: true },
};

const CONTACT = {
  id: 'corr-1',
  employer_id: 'emp-1',
  name: 'Jane Doe',
  email: 'jane@evercore.com',
  title: 'Managing Director',
  phone: null,
  type: null,
  department: null,
  specialization: null,
  seniority: null,
  coverage_region: null,
  linkedin_url: null,
  bio: null,
};

afterEach(() => {
  vi.clearAllMocks();
  getContactInsights.mockReset();
});

describe('getCrmContact', () => {
  it('reports what is on file and what is empty', async () => {
    findCorrespondentById.mockResolvedValue(CONTACT);
    findEmployerById.mockResolvedValue({ name: 'Evercore', industry: 'Investment Banking' });

    const result = (await getCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(result).toContain('Jane Doe @ Evercore');
    expect(result).toContain('**Title:** Managing Director');
    // Filled fields are not listed as the job.
    expect(result).toContain('Empty — what this run is for');
    expect(result).toContain('Seniority (`seniority`)');
    expect(result).toContain('LinkedIn URL (`linkedin_url`)');
    expect(result).not.toContain('Title (`title`)');
  });

  it('marks the email as off limits and the name as same-person corrections only', async () => {
    findCorrespondentById.mockResolvedValue(CONTACT);
    findEmployerById.mockResolvedValue({ name: 'Evercore' });

    const result = (await getCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(result).toContain('**Name:** Jane Doe  _(complete or correct it for the same person only — never rename to someone else)_');
    expect(result).toContain('**Email:** jane@evercore.com  _(you may not change this)_');
  });

  it('decodes HTML entities in the name, firm and filled fields it reports', async () => {
    findCorrespondentById.mockResolvedValue({
      ...CONTACT,
      name: 'Sean O&#39;Brien',
      title: 'Head of M&amp;amp;A',
    });
    findEmployerById.mockResolvedValue({ name: 'PT Maju &amp; Jaya', industry: 'Banking &amp; Finance' });

    const result = (await getCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(result).toContain("## CRM contact — Sean O'Brien @ PT Maju & Jaya");
    expect(result).toContain("**Name:** Sean O'Brien");
    expect(result).toContain('**Firm:** PT Maju & Jaya — Banking & Finance');
    expect(result).toContain('**Title:** Head of M&A');
    expect(result).not.toMatch(/&(amp|#39);/);
  });

  it('scopes the read to the active workspace', async () => {
    findCorrespondentById.mockResolvedValue(CONTACT);
    findEmployerById.mockResolvedValue({ name: 'Evercore' });

    await getCrmContact.invoke({ correspondent_id: 'corr-1' });

    expect(findCorrespondentById).toHaveBeenCalledWith('corr-1', 'ws-1');
  });

  it('tells the agent to stop when the contact is not visible here', async () => {
    findCorrespondentById.mockResolvedValue(undefined);

    const result = (await getCrmContact.invoke({ correspondent_id: 'nope' })) as string;

    expect(result).toContain('No CRM contact with id nope');
    expect(result).toContain('Do not look anyone up');
    expect(findEmployerById).not.toHaveBeenCalled();
  });

  it('says so when the record is already complete', async () => {
    findCorrespondentById.mockResolvedValue({
      ...CONTACT,
      phone: '+1 212 555 0100',
      type: 'Banker',
      department: 'M&A',
      specialization: 'TMT',
      seniority: 'Managing Director',
      coverage_region: 'North America',
      linkedin_url: 'https://linkedin.com/in/jane',
      bio: 'Twenty years in TMT M&A.',
    });
    findEmployerById.mockResolvedValue({ name: 'Evercore' });

    const result = (await getCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(result).toContain('Nothing is empty');
  });

  it('still reports the contact when the firm row is missing', async () => {
    findCorrespondentById.mockResolvedValue(CONTACT);
    findEmployerById.mockResolvedValue(undefined);

    const result = (await getCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(result).toContain('an unknown firm');
  });

  it('returns the error as a string rather than throwing into the agent', async () => {
    findCorrespondentById.mockRejectedValue(new Error('db down'));

    const result = (await getCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(result).toContain('**Error:** db down');
  });
  it('ends with the relationship with our team: team counts, last contact and deals', async () => {
    findCorrespondentById.mockResolvedValue(CONTACT);
    findEmployerById.mockResolvedValue({ name: 'Evercore' });
    getContactInsights.mockResolvedValue(INSIGHTS);

    const result = (await getCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(createContainer).toHaveBeenCalledWith({}, 'ws-1');
    expect(getContactInsights).toHaveBeenCalledWith('corr-1');
    expect(result).toContain('### Relationship with our team');
    expect(result).toContain('Never write any of this into the record');
    expect(result).toContain('2 team member(s) in touch: Alice (4 email(s)), Bob (1 email(s))');
    expect(result).toContain('Totals: 2 email(s) from us, 3 from them');
    expect(result).toContain('Last contact: 2026-10-14');
    expect(result).not.toMatch(/meeting/i);
    expect(result).toContain('Deals: brought 1, involved 0, reached L1 1 — Acme (brought, L1 · Screening)');
    // Existing output order kept: the brief comes first, the relationship last.
    expect(result.indexOf('Empty — what this run is for')).toBeLessThan(result.indexOf('Relationship with our team'));
  });

  it('writes "no data" instead of 0 when nothing is synced and no deal is linked', async () => {
    findCorrespondentById.mockResolvedValue(CONTACT);
    findEmployerById.mockResolvedValue({ name: 'Evercore' });
    getContactInsights.mockResolvedValue({
      ...INSIGHTS,
      interactions: { ...INSIGHTS.interactions, team: [], teamMemberCount: 0, hasSyncedData: false },
      deals: [],
      scorecard: { ...INSIGHTS.scorecard, dealsBrought: 0, reachedL1: 0, conversion: null, hasDealLinks: false },
    });

    const result = (await getCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(result).toContain('Interactions: no data (email sync may be off)');
    expect(result).toContain('Deals: no deal links recorded');
    expect(result).not.toContain('Totals:');
  });

  it('keeps the brief when the insights read fails', async () => {
    findCorrespondentById.mockResolvedValue(CONTACT);
    findEmployerById.mockResolvedValue({ name: 'Evercore' });
    getContactInsights.mockRejectedValue(new Error('mart missing'));

    const result = (await getCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(result).toContain('Jane Doe @ Evercore');
    expect(result).not.toContain('**Error:**');
    expect(result).toContain('Interactions: no data (email sync may be off)');
    expect(result).toContain('Deals: no data');
  });
});
