import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findCompany: vi.fn(),
  getState: vi.fn(),
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
vi.mock('@/lib/services', () => ({
  createContainer: vi.fn(() => ({
    companyContactDiscoveryService: { getState: mocks.getState },
  })),
}));

import { getCompanyForContacts } from './get_company_for_contacts';

const COMPANY = {
  id: 'co-1',
  target: 'Acme Logistics',
  website: 'https://www.acme.co.id/about',
  geography: 'Indonesia',
  segment: 'Logistics',
  company_focus: 'Last-mile delivery',
};

const EMPTY = { employer: null, contacts: [], totalContacts: 0, run: null };

beforeEach(() => {
  mocks.findCompany.mockReset().mockResolvedValue(COMPANY);
  mocks.getState.mockReset().mockResolvedValue(EMPTY);
});

describe('getCompanyForContacts', () => {
  it('reports the company identity and that it is not in the CRM yet', async () => {
    const result = (await getCompanyForContacts.invoke({ company_id: 'co-1' })) as string;

    expect(result).toContain('## Company — Acme Logistics');
    expect(result).toContain('**Domain:** acme.co.id');
    expect(result).toContain('**Country:** Indonesia');
    expect(result).toContain('not in the CRM yet');
    expect(mocks.getState).toHaveBeenCalledWith('co-1', 25);
  });

  it('lists the CRM firm and its contacts so the agent merges instead of duplicating', async () => {
    mocks.getState.mockResolvedValueOnce({
      employer: { id: 'emp-1', name: 'Acme Logistics', matchedBy: 'domain' },
      contacts: [
        { name: 'Jane Doe', title: 'CEO', email: 'jane@acme.co.id' },
        { name: 'Budi Santoso', title: null, email: null },
      ],
      totalContacts: 30,
      run: null,
    });

    const result = (await getCompanyForContacts.invoke({ company_id: 'co-1' })) as string;

    expect(result).toContain('CRM firm: **Acme Logistics** (matched on the website domain');
    expect(result).toContain('- Jane Doe — CEO <jane@acme.co.id>');
    expect(result).toContain('- Budi Santoso');
    expect(result).toContain('…and 28 more');
    expect(result).toContain('merges into their record');
  });

  it('tells the agent to find the website when none is usable', async () => {
    mocks.findCompany.mockResolvedValueOnce({ ...COMPANY, website: 'https://linkedin.com/company/acme' });

    const result = (await getCompanyForContacts.invoke({ company_id: 'co-1' })) as string;

    expect(result).toContain('There is no usable website on file');
  });

  it('stops the run for a company outside the workspace', async () => {
    mocks.findCompany.mockResolvedValueOnce(null);

    const result = (await getCompanyForContacts.invoke({ company_id: 'co-x' })) as string;

    expect(result).toContain('No company with id co-x');
    expect(mocks.getState).not.toHaveBeenCalled();
  });
});
