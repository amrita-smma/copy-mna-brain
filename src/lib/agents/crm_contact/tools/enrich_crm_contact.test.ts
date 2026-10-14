import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findCorrespondentById: vi.fn(),
  findEmployerById: vi.fn(),
  enrichPerson: vi.fn(),
  findPhone: vi.fn(),
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
  findPhone: mocks.findPhone,
  getTregApiKey: mocks.getTregApiKey,
}));

import { companyDomainFromEmail, enrichCrmContact } from './enrich_crm_contact';

const CONTACT = {
  id: 'corr-1',
  employer_id: 'emp-1',
  name: 'Jane Doe',
  email: 'jane@evercore.com',
  linkedin_url: null,
  phone: null,
};

const PHONE_MISS = { phone: null, verdict: null, servedBy: null, callId: 'p', costMicro: 0 };

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
  mocks.findPhone.mockReset().mockResolvedValue(PHONE_MISS);
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

  it('labels the vendor location as where they are based, never as coverage region', async () => {
    mocks.enrichPerson.mockResolvedValue({
      ...HIT,
      person: { ...HIT.person, location: 'Singapore' },
    });

    const result = (await enrichCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(result).toContain('**Based in:** Singapore');
    expect(result).not.toContain('**Location:**');
    expect(result).toContain('NOT their coverage region — do not write it to coverage_region');
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

describe('enrichCrmContact — full name', () => {
  it('flags a fuller vendor name and points the agent at update_crm_contact name', async () => {
    mocks.findCorrespondentById.mockResolvedValue({ ...CONTACT, name: 'Jane' });
    mocks.enrichPerson.mockResolvedValue(HIT);

    const result = (await enrichCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(result).toContain('**Full name differs** from the CRM\'s "Jane"');
    expect(result).toContain('pass it as `name` to update_crm_contact');
  });

  it('adds no name note when the vendor name matches the record', async () => {
    mocks.enrichPerson.mockResolvedValue(HIT);

    const result = (await enrichCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(result).not.toContain('Full name differs');
  });
});

describe('enrichCrmContact — phone', () => {
  it("looks the phone up with the profile's LinkedIn URL when the record has none", async () => {
    mocks.enrichPerson.mockResolvedValue(HIT);
    mocks.findPhone.mockResolvedValue({
      phone: '+6281100000',
      verdict: 'live',
      servedBy: 'aiark.people.phone.find',
      callId: 'call-p',
      costMicro: 26335,
    });

    const result = (await enrichCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(mocks.findPhone).toHaveBeenCalledWith({
      email: 'jane@evercore.com',
      full_name: 'Jane Doe',
      linkedin_url: 'https://linkedin.com/in/janedoe',
      domain: 'evercore.com',
    });
    expect(result).toContain('**Phone:** +6281100000');
    expect(result).toContain('**Line check:** live');
    expect(result).toContain('treg.to people.phone.find via aiark.people.phone.find (call call-p)');
  });

  it('skips the phone lookup when the record already holds a phone', async () => {
    mocks.findCorrespondentById.mockResolvedValue({ ...CONTACT, phone: '+1 212 000 0000' });
    mocks.enrichPerson.mockResolvedValue(HIT);

    const result = (await enrichCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(mocks.findPhone).not.toHaveBeenCalled();
    expect(result).not.toContain('### Phone');
  });

  it('tells the agent not to write a dead line', async () => {
    mocks.enrichPerson.mockResolvedValue(HIT);
    mocks.findPhone.mockResolvedValue({ ...PHONE_MISS, phone: '+6281100000', verdict: 'dead' });

    const result = (await enrichCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(result).toContain('Do not write this number.');
  });

  it('still looks the phone up on a profile miss and appends it', async () => {
    mocks.enrichPerson.mockResolvedValue({ person: null, servedBy: null, callId: 'c', costMicro: 0 });

    const result = (await enrichCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(mocks.findPhone).toHaveBeenCalled();
    expect(result).toContain('No enrichment record found');
    expect(result).toContain('No phone number found');
  });

  it('keeps the profile when the phone lookup fails', async () => {
    mocks.enrichPerson.mockResolvedValue(HIT);
    mocks.findPhone.mockRejectedValue(new Error('treg.people.phone.find returned 503: busy'));

    const result = (await enrichCrmContact.invoke({ correspondent_id: 'corr-1' })) as string;

    expect(result).toContain('**Title:** Managing Director');
    expect(result).toContain('Phone lookup failed');
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
