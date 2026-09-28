import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { NoActiveWorkspaceError } from '@/lib/workspace';

const {
  authMock,
  createDbMock,
  createContainerMock,
  getActiveWorkspaceIdOrThrowMock,
  getHeadMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createDbMock: vi.fn(),
  createContainerMock: vi.fn(),
  getActiveWorkspaceIdOrThrowMock: vi.fn(),
  getHeadMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace')>();
  return {
    ...actual,
    getActiveWorkspaceIdOrThrow: getActiveWorkspaceIdOrThrowMock,
  };
});
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));

import { GET } from './route';

const WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';
const INSIGHT_ID = '99999999-8888-4777-8666-555555555555';
const HEAD = { version_no: 7, created_at: '2026-09-24 03:00:00+00', trigger: 'routine' };

function call(id = INSIGHT_ID) {
  return GET(new NextRequest(`http://localhost/api/insights/${id}/head`), {
    params: Promise.resolve({ id }),
  });
}

describe('GET /api/insights/[id]/head', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    createDbMock.mockReset().mockReturnValue({});
    getActiveWorkspaceIdOrThrowMock.mockReset().mockResolvedValue(WORKSPACE_ID);
    getHeadMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      insightService: { getHead: getHeadMock },
    });
  });

  it('returns 401 without a session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await call();
    expect(res.status).toBe(401);
    expect(getHeadMock).not.toHaveBeenCalled();
  });

  it("returns the current version's number, publish time and trigger — no HTML", async () => {
    getHeadMock.mockResolvedValueOnce(HEAD);
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: HEAD });
    expect(body.data).not.toHaveProperty('html');
    expect(createContainerMock).toHaveBeenCalledWith({}, WORKSPACE_ID);
    expect(getHeadMock).toHaveBeenCalledWith(WORKSPACE_ID, INSIGHT_ID);
  });

  it('returns 404 when the insight is missing, archived or in another workspace', async () => {
    getHeadMock.mockResolvedValueOnce(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Insight not found' });
  });

  it('returns 404 for a malformed id without reading anything', async () => {
    const res = await call('not-a-uuid');

    expect(res.status).toBe(404);
    expect(getHeadMock).not.toHaveBeenCalled();
  });

  it('answers 403 without an active workspace and 500 on an unexpected error', async () => {
    getActiveWorkspaceIdOrThrowMock.mockRejectedValueOnce(new NoActiveWorkspaceError());
    expect((await call()).status).toBe(403);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    getHeadMock.mockRejectedValueOnce(new Error('boom'));
    const res = await call();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    consoleError.mockRestore();
  });
});
