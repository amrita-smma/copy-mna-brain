import { afterEach, describe, expect, it, vi } from 'vitest';

const findCorrespondentById = vi.fn();
const findEmployerById = vi.fn();

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

import { getCrmContact } from './get_crm_contact';

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

afterEach(() => vi.clearAllMocks());

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

  it('marks name and email as off limits', async () => {
    findCorrespondentById.mockResolvedValue(CONTACT);
    findEmployerById.mockResolvedValue({ name: 'Evercore' });

    const result = (await getCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(result).toContain('**Name:** Jane Doe  _(you may not change this)_');
    expect(result).toContain('**Email:** jane@evercore.com  _(you may not change this)_');
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
});
