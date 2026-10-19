import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ saveContacts: vi.fn() }));

vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: vi.fn(async () => 'ws-1'),
}));
vi.mock('@/lib/services/container', () => ({
  createContainer: vi.fn(() => ({
    companyContactDiscoveryService: { saveContacts: mocks.saveContacts },
  })),
}));

import { CompanyNotFoundError } from '@/lib/services/companyContactDiscoveryService';
import { saveCompanyContacts, saveCompanyContactsSchema } from './save_company_contacts';

const SRC = ['https://acme.co.id/team'];

beforeEach(() => {
  mocks.saveContacts.mockReset().mockResolvedValue({
    employer: { id: 'emp-1', name: 'Acme Logistics' },
    createdIds: ['c1'],
    mergedIds: ['c2'],
    mergedElsewhere: [],
  });
});

describe('saveCompanyContactsSchema', () => {
  it('rejects more than five contacts and a person without sources', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ name: `Person ${i}`, sources: SRC }));
    expect(saveCompanyContactsSchema.safeParse({ company_id: 'co-1', contacts: six }).success).toBe(false);
    expect(
      saveCompanyContactsSchema.safeParse({
        company_id: 'co-1',
        contacts: [{ name: 'Jane Doe', sources: [] }],
      }).success,
    ).toBe(false);
  });
});

describe('saveCompanyContacts', () => {
  it('files the people into the CRM via the service, stamped with the triggering user', async () => {
    const result = (await saveCompanyContacts.invoke(
      {
        company_id: 'co-1',
        contacts: [
          { name: 'Jane Doe', title: 'CEO', linkedin_url: 'https://linkedin.com/in/jane', sources: SRC },
          { name: 'Budi Santoso', title: 'Head of Partnerships', email: 'budi@acme.co.id', sources: SRC },
        ],
      },
      { configurable: { triggered_by_user_id: 'user-1' } },
    )) as string;

    expect(mocks.saveContacts).toHaveBeenCalledWith(
      'co-1',
      [
        expect.objectContaining({ name: 'Jane Doe', title: 'CEO', linkedinUrl: 'https://linkedin.com/in/jane', email: undefined }),
        expect.objectContaining({ name: 'Budi Santoso', email: 'budi@acme.co.id' }),
      ],
      { editedBy: 'user-1' },
    );
    expect(result).toContain('Filed under CRM firm **Acme Logistics**: 1 new contact(s), 1 merged');
  });

  it('tells the agent when an email match left someone under another firm', async () => {
    mocks.saveContacts.mockResolvedValueOnce({
      employer: { id: 'emp-1', name: 'Acme Logistics' },
      createdIds: [],
      mergedIds: ['c9'],
      mergedElsewhere: [{ id: 'c9', name: 'Jane Doe', employerId: 'emp-old' }],
    });

    const result = (await saveCompanyContacts.invoke({
      company_id: 'co-1',
      contacts: [{ name: 'Jane Doe', email: 'jane@acme.co.id', sources: SRC }],
    })) as string;

    expect(result).toContain('Already in the CRM under another firm');
    expect(result).toContain('- Jane Doe');
  });

  it('strips a generic inbox before it reaches the CRM', async () => {
    const result = (await saveCompanyContacts.invoke({
      company_id: 'co-1',
      contacts: [{ name: 'Jane Doe', email: 'info@acme.co.id', sources: SRC }],
    })) as string;

    expect(mocks.saveContacts.mock.calls[0][1][0].email).toBeUndefined();
    expect(result).toContain('a generic inbox is not their email');
  });

  it('reports a company outside the workspace without throwing', async () => {
    mocks.saveContacts.mockRejectedValueOnce(new CompanyNotFoundError('co-x'));

    const result = (await saveCompanyContacts.invoke({
      company_id: 'co-x',
      contacts: [{ name: 'Jane Doe', sources: SRC }],
    })) as string;

    expect(result).toContain('Nothing was saved');
  });
});
