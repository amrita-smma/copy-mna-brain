import { describe, it, expect, vi, beforeEach } from 'vitest';

const { authMock, createDbMock, createContainerMock, restoreWorkspaceMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  createDbMock: vi.fn(),
  createContainerMock: vi.fn(),
  restoreWorkspaceMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));

import { POST } from './route';
import { NotSuperadminError, WorkspaceNotFoundError } from '@/lib/services/workspaceService';

const USER_ID = 'user-1';
const WORKSPACE_ID = 'w1';

function makeRequest(): never {
  return {} as never;
}

const params = { params: Promise.resolve({ id: WORKSPACE_ID }) };

describe('POST /api/workspaces/[id]/restore', () => {
  beforeEach(() => {
    authMock.mockReset();
    createDbMock.mockReset().mockReturnValue({});
    restoreWorkspaceMock.mockReset();
    createContainerMock
      .mockReset()
      .mockReturnValue({ workspaceService: { restoreWorkspace: restoreWorkspaceMock } });
  });

  it('returns 401 without a session', async () => {
    authMock.mockResolvedValueOnce(null);

    const res = await POST(makeRequest(), params);

    expect(res.status).toBe(401);
    expect(restoreWorkspaceMock).not.toHaveBeenCalled();
  });

  it('reinstates the workspace and returns the live row', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    const live = { id: WORKSPACE_ID, name: 'W1', slug: 'w1', deleted_at: null };
    restoreWorkspaceMock.mockResolvedValueOnce(live);

    const res = await POST(makeRequest(), params);

    expect(res.status).toBe(200);
    expect(restoreWorkspaceMock).toHaveBeenCalledWith(USER_ID, WORKSPACE_ID);
    expect(await res.json()).toEqual({ data: live });
  });

  it('returns 403 when the caller is not a superadmin', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    restoreWorkspaceMock.mockRejectedValueOnce(new NotSuperadminError());

    const res = await POST(makeRequest(), params);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Forbidden' });
  });

  it('returns 404 for an unknown workspace id', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    restoreWorkspaceMock.mockRejectedValueOnce(new WorkspaceNotFoundError('nope'));

    const res = await POST(makeRequest(), params);

    expect(res.status).toBe(404);
  });
});
