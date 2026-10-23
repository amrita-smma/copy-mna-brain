import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiRequestMock } = vi.hoisted(() => ({ apiRequestMock: vi.fn() }));

vi.mock('@/lib/api/client', () => ({ apiRequest: apiRequestMock }));

import { getContactInsights } from './contactInsights';

beforeEach(() => {
  apiRequestMock.mockReset().mockResolvedValue({});
});

describe('getContactInsights', () => {
  it('GETs the bare insights URL, id encoded, without a period or for all time', async () => {
    await getContactInsights('a/b');
    await getContactInsights('a/b', { period: 'all' });

    expect(apiRequestMock.mock.calls).toEqual([
      ['/api/crm/correspondents/a%2Fb/insights'],
      ['/api/crm/correspondents/a%2Fb/insights'],
    ]);
  });

  it('sends any other period as a query parameter', async () => {
    await getContactInsights('c123', { period: '30d' });
    expect(apiRequestMock).toHaveBeenCalledWith('/api/crm/correspondents/c123/insights?period=30d');
  });
});
