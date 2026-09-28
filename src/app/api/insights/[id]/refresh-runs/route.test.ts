import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { NoActiveWorkspaceError } from '@/lib/workspace';

const {
  authMock,
  createDbMock,
  createContainerMock,
  getActiveWorkspaceIdOrThrowMock,
  listFailedRefreshRunsMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createDbMock: vi.fn(),
  createContainerMock: vi.fn(),
  getActiveWorkspaceIdOrThrowMock: vi.fn(),
  listFailedRefreshRunsMock: vi.fn(),
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
vi.mock('@/lib/services/container', () => ({
  createContainer: createContainerMock,
}));

import { GET } from './route';

const WORKSPACE_ID = 'ws-test-1';
const INSIGHT_ID = 'insight-test-1';

function call() {
  const req = new NextRequest(`http://localhost/api/insights/${INSIGHT_ID}/refresh-runs`);
  return GET(req, { params: Promise.resolve({ id: INSIGHT_ID }) });
}

describe('GET /api/insights/[id]/refresh-runs', () => {
  beforeEach(() => {
    authMock.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    createDbMock.mockReset().mockReturnValue({});
    getActiveWorkspaceIdOrThrowMock.mockReset().mockResolvedValue(WORKSPACE_ID);
    listFailedRefreshRunsMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      aiWorkforceService: { listFailedRefreshRuns: listFailedRefreshRunsMock },
    });
  });

  it('returns 401 without a session and never touches the DB', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await call();
    expect(res.status).toBe(401);
    expect(createDbMock).not.toHaveBeenCalled();
  });

  it('returns { data } with the failed runs, built from the active workspace container', async () => {
    const runs = [{ run_id: 'run-1', status: 'failed', reason: 'insight archived' }];
    listFailedRefreshRunsMock.mockResolvedValueOnce(runs);

    const res = await call();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: runs });
    expect(createContainerMock).toHaveBeenCalledWith({}, WORKSPACE_ID);
    expect(listFailedRefreshRunsMock).toHaveBeenCalledWith(INSIGHT_ID);
  });

  it('answers 403 without an active workspace and a generic 500 on an unexpected error', async () => {
    getActiveWorkspaceIdOrThrowMock.mockRejectedValueOnce(new NoActiveWorkspaceError());
    expect((await call()).status).toBe(403);

    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    listFailedRefreshRunsMock.mockRejectedValueOnce(new Error('db down'));
    const res = await call();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
