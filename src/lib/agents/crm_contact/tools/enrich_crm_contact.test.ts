import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findCorrespondentById: vi.fn(),
  findEmployerById: vi.fn(),
  enrichPerson: vi.fn(),
  getTregApiKey: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: vi.fn(async () => 'ws-1'),
}));
vi.mock('@/lib/repositories', () => ({
  CorrespondentRepository: class {
    findById = mocks.findCorrespondentById;
  },
  EmployerRepository: class {
    findById = mocks.findEmployerById;
  },
}));
vi.mock('@/lib/treg', () => ({
  enrichPerson: mocks.enrichPerson,
  getTregApiKey: mocks.getTregApiKey,
}));

import { companyDomainFromEmail, enrichCrmContact } from './enrich_crm_contact';

const CONTACT = {
  id: 'corr-1',
  employer_id: 'emp-1',
  name: 'Jane Doe',
  email: 'jane@evercore.com',
  linkedin_url: null,
};

const HIT = {
  person: {
    full_name: 'Jane Doe',
    title: 'Managing Director',
    company: { name: 'Evercore', website_url: 'evercore.com' },
    linkedin_url: 'linkedin.com/in/janedoe',
  },
  servedBy: 'moltsets.people.enrich.name',
  callId: 'call-1',
  costMicro: 10000,
};

beforeEach(() => {
  mocks.findCorrespondentById.mockReset().mockResolvedValue(CONTACT);
  mocks.findEmployerById.mockReset().mockResolvedValue({ name: 'Evercore' });
  mocks.enrichPerson.mockReset();
  mocks.getTregApiKey.mockReset().mockReturnValue('tk_test');
});

afterEach(() => vi.clearAllMocks());

describe('enrichCrmContact', () => {
  it("matches on the contact's email, name and work-email domain", async () => {
    mocks.enrichPerson.mockResolvedValue(HIT);

    await enrichCrmContact.invoke({ correspondent_id: 'corr-1' });

    expect(mocks.findCorrespondentById).toHaveBeenCalledWith('corr-1', 'ws-1');
    expect(mocks.enrichPerson).toHaveBeenCalledWith({
      email: 'jane@evercore.com',
      full_name: 'Jane Doe',
      linkedin_url: undefined,
      domain: 'evercore.com',
    });
  });

  it('prefers a LinkedIn URL and domain the agent passes over what is on file', async () => {
    mocks.findCorrespondentById.mockResolvedValue({
      ...CONTACT,
      linkedin_url: 'https://linkedin.com/in/old',
    });
    mocks.enrichPerson.mockResolvedValue(HIT);

    await enrichCrmContact.invoke({
      correspondent_id: 'corr-1',
      linkedin_url: 'https://www.linkedin.com/in/janedoe',
      company_domain: 'evercore.co.uk',
    });

    expect(mocks.enrichPerson).toHaveBeenCalledWith(
      expect.objectContaining({
        linkedin_url: 'https://www.linkedin.com/in/janedoe',
        domain: 'evercore.co.uk',
      }),
    );
  });

  it('renders the profile, an employer check and the source string to cite', async () => {
    mocks.enrichPerson.mockResolvedValue({
      ...HIT,
      person: { ...HIT.person, summary: 'Long vendor bio that must not appear in output.' },
    });

    const result = (await enrichCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(result).not.toContain('Long vendor bio');
    expect(result).toContain('**Title:** Managing Director');
    expect(result).toContain('**Company:** Evercore');
    // Scheme-less LinkedIn URLs are made absolute so update_crm_contact accepts them.
    expect(result).toContain('**LinkedIn URL:** https://linkedin.com/in/janedoe');
    expect(result).toContain('the company must be Evercore');
    expect(result).toContain('treg.to people.enrich via moltsets.people.enrich.name (call call-1)');
  });

  it('reports a miss and points the agent back to web search', async () => {
    mocks.enrichPerson.mockResolvedValue({ person: null, servedBy: null, callId: 'c', costMicro: 0 });

    const result = (await enrichCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(result).toContain('No enrichment record found for Jane Doe @ Evercore');
    expect(result).toContain('web_search');
  });

  it('stops without calling treg when the contact is not in the workspace', async () => {
    mocks.findCorrespondentById.mockResolvedValue(undefined);

    const result = (await enrichCrmContact.invoke({ correspondent_id: 'nope' })) as string;

    expect(result).toContain('No CRM contact with id nope');
    expect(mocks.enrichPerson).not.toHaveBeenCalled();
  });

  it('degrades to web search when TREG_API_KEY is not configured', async () => {
    mocks.getTregApiKey.mockReturnValue(undefined);

    const result = (await enrichCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(result).toContain('TREG_API_KEY is not set');
    expect(mocks.findCorrespondentById).not.toHaveBeenCalled();
    expect(mocks.enrichPerson).not.toHaveBeenCalled();
  });

  it('returns the failure as text instead of throwing when treg errors', async () => {
    mocks.enrichPerson.mockRejectedValue(new Error('treg.people.enrich returned 503: busy'));

    const result = (await enrichCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(result).toContain('contact enrichment failed');
    expect(result).toContain('503');
  });
});

describe('companyDomainFromEmail', () => {
  it('returns the work-email domain', () => {
    expect(companyDomainFromEmail('Jane@Evercore.com')).toBe('evercore.com');
  });

  it('ignores personal mailboxes and missing emails', () => {
    expect(companyDomainFromEmail('jane@gmail.com')).toBeUndefined();
    expect(companyDomainFromEmail(null)).toBeUndefined();
    expect(companyDomainFromEmail('not-an-email')).toBeUndefined();
  });
});
