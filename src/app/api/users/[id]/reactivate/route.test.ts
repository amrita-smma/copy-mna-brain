import { describe, it, expect, vi, beforeEach } from 'vitest';

const { authMock, createDbMock, createContainerMock, isSuperadminMock, reactivateUserMock } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    createDbMock: vi.fn(),
    createContainerMock: vi.fn(),
    isSuperadminMock: vi.fn(),
    reactivateUserMock: vi.fn(),
  }));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));

import { POST } from './route';
import { UserNotFoundError } from '@/lib/services/userService';

const USER_ID = 'admin-1';
const TARGET = 'u1';
const params = { params: Promise.resolve({ id: TARGET }) };

describe('POST /api/users/[id]/reactivate', () => {
  beforeEach(() => {
    authMock.mockReset();
    createDbMock.mockReset().mockReturnValue({});
    isSuperadminMock.mockReset().mockResolvedValue(true);
    reactivateUserMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      workspaceService: { isSuperadmin: isSuperadminMock },
      userService: { reactivateUser: reactivateUserMock },
    });
  });

  it('returns 401 without a session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await POST({} as never, params);
    expect(res.status).toBe(401);
    expect(reactivateUserMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not a superadmin', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    isSuperadminMock.mockResolvedValueOnce(false);
    const res = await POST({} as never, params);
    expect(res.status).toBe(403);
    expect(reactivateUserMock).not.toHaveBeenCalled();
  });

  it('reactivates the user', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    const data = { id: TARGET, deactivated_at: null };
    reactivateUserMock.mockResolvedValueOnce(data);
    const res = await POST({} as never, params);
    expect(res.status).toBe(200);
    expect(reactivateUserMock).toHaveBeenCalledWith(TARGET);
    expect(await res.json()).toEqual({ data });
  });

  it('returns 404 for an unknown user', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    reactivateUserMock.mockRejectedValueOnce(new UserNotFoundError('nope'));
    const res = await POST({} as never, params);
    expect(res.status).toBe(404);
  });
});
