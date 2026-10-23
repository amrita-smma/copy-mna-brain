import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  createDbMock,
  createContainerMock,
  getActiveWorkspaceIdMock,
  listBankersMock,
  crmBankersViewEnabledMock,
} = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  createContainerMock: vi.fn(),
  getActiveWorkspaceIdMock: vi.fn(),
  listBankersMock: vi.fn(),
  crmBankersViewEnabledMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: getActiveWorkspaceIdMock }));
vi.mock('@/lib/flags', () => ({ crmBankersViewEnabled: crmBankersViewEnabledMock }));

import { GET } from './route';
import { InvalidBankerListSortError } from '@/lib/services/bankerListService';

function req(query: string) {
  return { nextUrl: new URL(`http://localhost/api/crm/contacts${query}`) } as never;
}

describe('GET /api/crm/contacts', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({ db: true });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('w1');
    listBankersMock.mockReset();
    crmBankersViewEnabledMock.mockReset().mockResolvedValue(true);
    createContainerMock.mockReset().mockReturnValue({
      bankerListService: { listBankers: listBankersMock },
    });
  });

  it('returns 404 without touching the DB when the Bankers view is off', async () => {
    crmBankersViewEnabledMock.mockResolvedValueOnce(false);

    const res = await GET(req('?sort=deals_brought'));

    expect(res.status).toBe(404);
    expect(createDbMock).not.toHaveBeenCalled();
    expect(listBankersMock).not.toHaveBeenCalled();
  });

  it('passes every query param to the service and wraps the result in data', async () => {
    const data = { rows: [], total: 0, totalUnfiltered: 3 };
    listBankersMock.mockResolvedValueOnce(data);

    const res = await GET(
      req(
        '?q=golden&sort=deals_brought&lastContact=custom&customDate=2026-09-01&clientTodayIso=2026-10-16T17:00:00.000Z&team=u1,%20u2,&hasDeals=1&active30=1&page=2&pageSize=50',
      ),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data });
    expect(createContainerMock).toHaveBeenCalledWith({ db: true }, 'w1');
    expect(listBankersMock).toHaveBeenCalledWith({
      q: 'golden',
      sort: 'deals_brought',
      lastContact: 'custom',
      customDate: '2026-09-01',
      clientTodayIso: '2026-10-16T17:00:00.000Z',
      teamUserIds: ['u1', 'u2'],
      hasDeals: true,
      active30: true,
      page: 2,
      pageSize: 50,
    });
  });

  it('sends nulls and false for absent params', async () => {
    listBankersMock.mockResolvedValueOnce({ rows: [] });

    await GET(req(''));

    expect(listBankersMock).toHaveBeenCalledWith({
      q: null,
      sort: null,
      lastContact: null,
      customDate: null,
      clientTodayIso: null,
      teamUserIds: [],
      hasDeals: false,
      active30: false,
      page: null,
      pageSize: null,
    });
  });

  it('returns 400 for a sort outside the whitelist', async () => {
    listBankersMock.mockRejectedValueOnce(new InvalidBankerListSortError('bogus'));

    const res = await GET(req('?sort=bogus'));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('Invalid sort');
  });

  it('returns 500 on an unexpected error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    listBankersMock.mockRejectedValueOnce(new Error('boom'));

    const res = await GET(req(''));

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    errSpy.mockRestore();
  });
});
