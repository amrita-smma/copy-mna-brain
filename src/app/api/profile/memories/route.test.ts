import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getActiveWorkspaceId: vi.fn(),
  createContainer: vi.fn(),
  copilotMemoryEnabled: vi.fn(),
  list: vi.fn(),
  forgetAll: vi.fn(),
  preference: vi.fn(),
  setPreference: vi.fn(),
  available: vi.fn(),
  userMemoryService: vi.fn(),
}));

vi.mock('@/lib/server/session', () => ({ getSession: mocks.getSession }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: mocks.getActiveWorkspaceId }));
vi.mock('@/lib/services/container', () => ({ createContainer: mocks.createContainer }));
vi.mock('@/lib/flags', () => ({ copilotMemoryEnabled: mocks.copilotMemoryEnabled }));

import { DELETE, GET, PATCH } from './route';

const URL = 'http://localhost/api/profile/memories';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSession.mockResolvedValue({ user: { id: 'user-1' } });
  mocks.getActiveWorkspaceId.mockResolvedValue('ws-1');
  mocks.copilotMemoryEnabled.mockResolvedValue(true);
  mocks.list.mockResolvedValue({ items: [], total: 0, hasMore: false });
  mocks.forgetAll.mockResolvedValue(0);
  mocks.preference.mockResolvedValue(true);
  mocks.setPreference.mockImplementation(async (v: boolean) => v);
  mocks.available.mockReturnValue(true);
  mocks.userMemoryService.mockReturnValue({
    list: mocks.list,
    forgetAll: mocks.forgetAll,
    preference: mocks.preference,
    setPreference: mocks.setPreference,
    available: mocks.available,
  });
  mocks.createContainer.mockReturnValue({ userMemoryService: mocks.userMemoryService });
});

describe('GET /api/profile/memories', () => {
  it('serves the session user’s memories from the active workspace', async () => {
    mocks.list.mockResolvedValue({
      items: [{ id: 'm1', memory: 'Covers coal', source: 'copilot' }],
      total: 1,
      hasMore: false,
    });

    const res = await GET(new NextRequest(URL));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      data: {
        items: [{ id: 'm1', memory: 'Covers coal', source: 'copilot' }],
        total: 1,
        hasMore: false,
        available: true,
        enabled: true,
      },
    });
    expect(mocks.userMemoryService).toHaveBeenCalledWith('user-1');
  });

  it('reads the user from the session, never from a query param', async () => {
    await GET(new NextRequest(`${URL}?userId=someone-else`));

    expect(mocks.userMemoryService).toHaveBeenCalledWith('user-1');
    expect(mocks.userMemoryService).toHaveBeenCalledTimes(1);
  });

  it('401s without a session', async () => {
    mocks.getSession.mockResolvedValue(null);

    const res = await GET(new NextRequest(URL));

    expect(res.status).toBe(401);
    expect(mocks.createContainer).not.toHaveBeenCalled();
  });

  it('reports the deployment switch as off rather than as an empty memory', async () => {
    mocks.copilotMemoryEnabled.mockResolvedValue(false);

    const res = await GET(new NextRequest(URL));

    await expect(res.json()).resolves.toEqual({
      data: { items: [], total: 0, hasMore: false, available: false, enabled: false },
    });
    expect(mocks.createContainer).not.toHaveBeenCalled();
  });

  it('still lists the memories of a user who switched memory off', async () => {
    mocks.preference.mockResolvedValue(false);
    mocks.list.mockResolvedValue({
      items: [{ id: 'm1', memory: 'Covers coal', source: 'copilot' }],
      total: 1,
      hasMore: false,
    });

    const res = await GET(new NextRequest(URL));
    const { data } = await res.json();

    expect(data.available).toBe(true);
    expect(data.enabled).toBe(false);
    expect(data.items).toHaveLength(1);
  });

  it('passes a numeric limit and offset through to the service', async () => {
    await GET(new NextRequest(`${URL}?limit=5&offset=10`));

    expect(mocks.list).toHaveBeenCalledWith(5, 10);
  });

  it('400s on a non-numeric limit or offset', async () => {
    expect((await GET(new NextRequest(`${URL}?limit=lots`))).status).toBe(400);
    expect((await GET(new NextRequest(`${URL}?offset=later`))).status).toBe(400);
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('500s on an unexpected failure', async () => {
    mocks.list.mockRejectedValue(new Error('boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await GET(new NextRequest(URL));

    expect(res.status).toBe(500);
    spy.mockRestore();
  });
});

describe('PATCH /api/profile/memories', () => {
  const patch = (body: unknown) =>
    new NextRequest(URL, { method: 'PATCH', body: JSON.stringify(body) });

  it('stores the session user’s preference and echoes it back', async () => {
    const res = await PATCH(patch({ enabled: false }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: { enabled: false } });
    expect(mocks.userMemoryService).toHaveBeenCalledWith('user-1');
    expect(mocks.setPreference).toHaveBeenCalledWith(false);
  });

  it('takes the user from the session, never from the body', async () => {
    await PATCH(patch({ enabled: true, userId: 'someone-else' }));

    expect(mocks.userMemoryService).toHaveBeenCalledWith('user-1');
  });

  it('400s on a missing or non-boolean enabled', async () => {
    expect((await PATCH(patch({}))).status).toBe(400);
    expect((await PATCH(patch({ enabled: 'yes' }))).status).toBe(400);
    expect(mocks.setPreference).not.toHaveBeenCalled();
  });

  it('401s without a session', async () => {
    mocks.getSession.mockResolvedValue(null);

    expect((await PATCH(patch({ enabled: false }))).status).toBe(401);
    expect(mocks.setPreference).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/profile/memories', () => {
  it('works even when the deployment switch is off, so data is never stranded', async () => {
    mocks.copilotMemoryEnabled.mockResolvedValue(false);
    mocks.forgetAll.mockResolvedValue(3);

    const res = await DELETE();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: { deleted: 3 } });
  });

  it('clears the session user’s memories and reports the count', async () => {
    mocks.forgetAll.mockResolvedValue(4);

    const res = await DELETE();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ data: { deleted: 4 } });
    expect(mocks.userMemoryService).toHaveBeenCalledWith('user-1');
  });

  it('401s without a session', async () => {
    mocks.getSession.mockResolvedValue(null);

    expect((await DELETE()).status).toBe(401);
    expect(mocks.forgetAll).not.toHaveBeenCalled();
  });
});
