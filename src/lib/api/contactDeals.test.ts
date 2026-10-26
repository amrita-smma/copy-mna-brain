import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiRequestMock } = vi.hoisted(() => ({ apiRequestMock: vi.fn() }));

vi.mock('@/lib/api/client', () => ({ apiRequest: apiRequestMock }));

import * as contactDeals from './contactDeals';
import { addContactDeal, removeContactDeal } from './contactDeals';

beforeEach(() => {
  apiRequestMock.mockReset().mockResolvedValue({});
});

describe('addContactDeal', () => {
  it('POSTs the company and role, encoding the contact id', async () => {
    await addContactDeal('c/1', 'co1', 'source');
    expect(apiRequestMock).toHaveBeenCalledWith('/api/crm/correspondents/c%2F1/deals', {
      method: 'POST',
      body: JSON.stringify({ companyId: 'co1', role: 'source' }),
    });
  });
});

describe('removeContactDeal', () => {
  it('DELETEs the link', async () => {
    await removeContactDeal('c1', 'co/1');
    expect(apiRequestMock).toHaveBeenCalledWith('/api/crm/correspondents/c1/deals/co%2F1', {
      method: 'DELETE',
    });
  });
});

describe('contactDeals client', () => {
  it('offers only manual add and remove — email mentions link automatically', () => {
    expect(Object.keys(contactDeals).sort()).toEqual(['addContactDeal', 'removeContactDeal']);
  });
});
