import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { getSessionMock, getActiveWorkspaceIdMock, createContainerMock, getMyItemsMock } =
  vi.hoisted(() => ({
    getSessionMock: vi.fn(),
    getActiveWorkspaceIdMock: vi.fn(),
    createContainerMock: vi.fn(),
    getMyItemsMock: vi.fn(),
  }));

vi.mock('@/lib/server/session', () => ({ getSession: getSessionMock }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({
  getActiveWorkspaceId: getActiveWorkspaceIdMock,
}));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));

import { GET } from './route';

const URL = 'http://localhost/api/profile/items';
const EMPTY = {
  companies: { items: [], total: 0 },
  insights: { items: [], total: 0 },
  actionItems: { items: [], total: 0 },
};

describe('GET /api/profile/items', () => {
  beforeEach(() => {
    getSessionMock.mockReset().mockResolvedValue({ user: { id: 'user-1' } });
    getActiveWorkspaceIdMock.mockReset().mockResolvedValue('ws-1');
    getMyItemsMock.mockReset().mockResolvedValue(EMPTY);
    createContainerMock
      .mockReset()
      .mockReturnValue({ profileService: { getMyItems: getMyItemsMock } });
  });

  it('serves the session user’s items from the active workspace', async () => {
    const data = { ...EMPTY, companies: { items: [{ id: 'c-1' }], total: 1 } };
    getMyItemsMock.mockResolvedValueOnce(data);

    const res = await GET(new NextRequest(URL));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data });
    expect(createContainerMock).toHaveBeenCalledWith({}, 'ws-1');
    expect(getMyItemsMock).toHaveBeenCalledWith('user-1', { limit: undefined });
  });

  it('reads the user from the session, never from a query param', async () => {
    await GET(new NextRequest(`${URL}?userId=someone-else`));

    expect(getMyItemsMock).toHaveBeenCalledWith('user-1', { limit: undefined });
  });

  it('passes a numeric limit through to the service', async () => {
    await GET(new NextRequest(`${URL}?limit=5`));

    expect(getMyItemsMock).toHaveBeenCalledWith('user-1', { limit: 5 });
  });

  it('rejects a non-numeric limit with a 400', async () => {
    const res = await GET(new NextRequest(`${URL}?limit=lots`));

    expect(res.status).toBe(400);
    expect(getMyItemsMock).not.toHaveBeenCalled();
  });

  it('401s when there is no signed-in user', async () => {
    getSessionMock.mockResolvedValueOnce(null);

    const res = await GET(new NextRequest(URL));

    expect(res.status).toBe(401);
    expect(getMyItemsMock).not.toHaveBeenCalled();
  });

  it('returns empty sections — not an error — when the user has no active workspace', async () => {
    getActiveWorkspaceIdMock.mockResolvedValueOnce(null);

    const res = await GET(new NextRequest(URL));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: EMPTY });
    expect(createContainerMock).not.toHaveBeenCalled();
  });

  it('returns a 500 when the service throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    getMyItemsMock.mockRejectedValueOnce(new Error('boom'));

    const res = await GET(new NextRequest(URL));

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Internal server error' });
    consoleError.mockRestore();
  });
});
