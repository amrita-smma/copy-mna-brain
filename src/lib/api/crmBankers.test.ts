import { describe, it, expect, vi, beforeEach } from 'vitest';

const { apiRequestMock } = vi.hoisted(() => ({ apiRequestMock: vi.fn() }));

vi.mock('@/lib/api/client', () => ({ apiRequest: apiRequestMock }));

import { listBankers } from './crmBankers';

beforeEach(() => {
  apiRequestMock.mockReset().mockResolvedValue({ rows: [] });
});

describe('listBankers', () => {
  it('GETs the bankers list without a query string when no params are set', async () => {
    await listBankers();
    expect(apiRequestMock).toHaveBeenCalledWith('/api/crm/contacts');
  });

  it('encodes every filter, the sort and the page', async () => {
    await listBankers({
      q: 'golden sacks',
      sort: 'reached_l1',
      lastContact: 'month',
      clientTodayIso: '2026-10-16T17:00:00.000Z',
      teamUserIds: ['u1', 'u2'],
      hasDeals: true,
      active30: true,
      page: 2,
      pageSize: 25,
    });

    const url = new URL(apiRequestMock.mock.calls[0][0], 'http://x');
    expect(url.pathname).toBe('/api/crm/contacts');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'golden sacks',
      sort: 'reached_l1',
      lastContact: 'month',
      clientTodayIso: '2026-10-16T17:00:00.000Z',
      team: 'u1,u2',
      hasDeals: '1',
      active30: '1',
      page: '2',
      pageSize: '25',
    });
  });
});
