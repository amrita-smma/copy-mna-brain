import { beforeEach, describe, expect, it, vi } from 'vitest';

const { authMock, getStatesMock, discoverManyMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  getStatesMock: vi.fn(),
  discoverManyMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services/container', () => ({
  createContainer: vi.fn(() => ({
    companyContactDiscoveryService: { getStates: getStatesMock, discoverMany: discoverManyMock },
  })),
}));

import { NextRequest } from 'next/server';
import { GET, POST } from './route';

beforeEach(() => {
  authMock.mockReset().mockResolvedValue({ user: { id: 'user-1' } });
  getStatesMock.mockReset().mockResolvedValue({});
  discoverManyMock.mockReset().mockResolvedValue({ queued: [], alreadyQueued: [], skipped: [] });
});

describe('GET /api/companies/contacts', () => {
  it('returns every requested company’s contacts state from one service call', async () => {
    getStatesMock.mockResolvedValueOnce({ 'co-1': { employer: null } });

    const res = await GET(new NextRequest('http://localhost/api/companies/contacts?ids=co-1, co-2'));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { 'co-1': { employer: null } } });
    expect(getStatesMock).toHaveBeenCalledWith(['co-1', 'co-2']);
  });

  it('rejects more than 100 ids', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `co-${i}`).join(',');
    const res = await GET(new NextRequest(`http://localhost/api/companies/contacts?ids=${ids}`));
    expect(res.status).toBe(400);
    expect(getStatesMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/companies/contacts', () => {
  const post = (body: unknown) =>
    POST(
      new NextRequest('http://localhost/api/companies/contacts', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );

  it('queues searches as the signed-in user, passing onlyMissing through', async () => {
    discoverManyMock.mockResolvedValueOnce({ queued: ['co-1'], alreadyQueued: [], skipped: [] });

    const res = await post({ companyIds: ['co-1'], onlyMissing: true });

    expect(res.status).toBe(200);
    expect((await res.json()).data.queued).toEqual(['co-1']);
    expect(discoverManyMock).toHaveBeenCalledWith(['co-1'], {
      triggeredByUserId: 'user-1',
      onlyMissing: true,
    });
  });

  it('rejects a body without an id array', async () => {
    const res = await post({ companyIds: 'co-1' });
    expect(res.status).toBe(400);
    expect(discoverManyMock).not.toHaveBeenCalled();
  });

  it('rejects more companies than one bulk search allows', async () => {
    const res = await post({ companyIds: Array.from({ length: 11 }, (_, i) => `co-${i}`) });
    expect(res.status).toBe(400);
  });
});
