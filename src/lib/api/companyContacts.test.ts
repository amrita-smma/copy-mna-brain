import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiRequestMock } = vi.hoisted(() => ({ apiRequestMock: vi.fn() }));

vi.mock('@/lib/api/client', () => ({ apiRequest: apiRequestMock }));

import { findCompanyContacts, getCompanyContacts } from './companyContacts';

beforeEach(() => {
  apiRequestMock.mockReset();
});

describe('getCompanyContacts', () => {
  it('GETs the company contacts endpoint with the id encoded', async () => {
    apiRequestMock.mockResolvedValueOnce({ contacts: [], run: null });

    await expect(getCompanyContacts('a/b')).resolves.toEqual({ contacts: [], run: null });
    expect(apiRequestMock).toHaveBeenCalledWith('/api/companies/a%2Fb/contacts');
  });
});

describe('findCompanyContacts', () => {
  it('POSTs to the same endpoint to start a run', async () => {
    apiRequestMock.mockResolvedValueOnce({ runId: 'r1', created: true });

    await findCompanyContacts('co-1');
    expect(apiRequestMock).toHaveBeenCalledWith('/api/companies/co-1/contacts', { method: 'POST' });
  });
});
