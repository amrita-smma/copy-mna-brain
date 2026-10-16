import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findCompany: vi.fn(),
  enrichPerson: vi.fn(),
  findPhone: vi.fn(),
  getTregApiKey: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: vi.fn(async () => 'ws-1'),
}));
vi.mock('@/lib/repositories', () => ({
  CompanyRepository: class {
    findByIdOrNull = mocks.findCompany;
  },
}));
vi.mock('@/lib/treg', () => ({
  enrichPerson: mocks.enrichPerson,
  findPhone: mocks.findPhone,
  getTregApiKey: mocks.getTregApiKey,
}));

import { enrichCompanyContact } from './enrich_company_contact';

const HIT = {
  person: {
    full_name: 'Jane Doe',
    title: 'VP Business Development',
    company: { name: 'Acme Logistics', website_url: 'acme.co.id' },
    linkedin_url: 'linkedin.com/in/janedoe',
  },
  servedBy: 'moltsets.people.enrich.name',
  callId: 'call-1',
  costMicro: 10000,
};

beforeEach(() => {
  mocks.findCompany.mockReset().mockResolvedValue({ id: 'co-1', target: 'Acme Logistics', website: 'https://acme.co.id' });
  mocks.enrichPerson.mockReset().mockResolvedValue(HIT);
  mocks.findPhone.mockReset();
  mocks.getTregApiKey.mockReset().mockReturnValue('tk_test');
});

describe('enrichCompanyContact', () => {
  it('looks the person up by name and the company domain, and cites the vendor source', async () => {
    const result = (await enrichCompanyContact.invoke({
      company_id: 'co-1',
      full_name: 'Jane Doe',
    })) as string;

    expect(mocks.enrichPerson).toHaveBeenCalledWith({
      full_name: 'Jane Doe',
      linkedin_url: undefined,
      domain: 'acme.co.id',
    });
    expect(result).toContain('**Title:** VP Business Development');
    expect(result).toContain('https://linkedin.com/in/janedoe');
    expect(result).toContain('treg.to people.enrich via moltsets.people.enrich.name (call call-1)');
    expect(mocks.findPhone).not.toHaveBeenCalled();
  });

  it('looks up a phone only when asked, and refuses a dead line', async () => {
    mocks.findPhone.mockResolvedValueOnce({
      phone: '+62811000000',
      verdict: 'dead',
      servedBy: 'x',
      callId: 'p1',
      costMicro: 0,
    });

    const result = (await enrichCompanyContact.invoke({
      company_id: 'co-1',
      full_name: 'Jane Doe',
      with_phone: true,
    })) as string;

    expect(mocks.findPhone).toHaveBeenCalledWith(
      expect.objectContaining({ linkedin_url: 'https://linkedin.com/in/janedoe' }),
    );
    expect(result).toContain('dead — do not save this number');
  });

  it('reports a miss without treating it as evidence', async () => {
    mocks.enrichPerson.mockResolvedValueOnce({ person: null, servedBy: null, callId: null, costMicro: 0 });

    const result = (await enrichCompanyContact.invoke({
      company_id: 'co-1',
      full_name: 'Jane Doe',
    })) as string;

    expect(result).toContain('No enrichment record found for Jane Doe @ Acme Logistics');
  });

  it('falls back to web search when treg is not configured', async () => {
    mocks.getTregApiKey.mockReturnValueOnce(undefined);

    const result = (await enrichCompanyContact.invoke({
      company_id: 'co-1',
      full_name: 'Jane Doe',
    })) as string;

    expect(result).toContain('TREG_API_KEY is not set');
    expect(mocks.enrichPerson).not.toHaveBeenCalled();
  });

  it('turns a provider failure into a message, not a thrown error', async () => {
    mocks.enrichPerson.mockRejectedValueOnce(new Error('boom'));

    const result = (await enrichCompanyContact.invoke({
      company_id: 'co-1',
      full_name: 'Jane Doe',
    })) as string;

    expect(result).toContain('contact enrichment failed (boom)');
  });
});
