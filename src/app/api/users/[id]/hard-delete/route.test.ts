import { describe, it, expect, vi, beforeEach } from 'vitest';

const { authMock, createDbMock, createContainerMock, isSuperadminMock, hardDeleteUserMock } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    createDbMock: vi.fn(),
    createContainerMock: vi.fn(),
    isSuperadminMock: vi.fn(),
    hardDeleteUserMock: vi.fn(),
  }));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services/container', () => ({ createContainer: createContainerMock }));

import { POST } from './route';
import {
  CannotDeleteSelfError,
  DeleteConfirmationMismatchError,
  UserHasRetainedHistoryError,
  UserNotDeactivatedError,
  UserNotFoundError,
} from '@/lib/services/userService';

const USER_ID = 'admin-1';
const TARGET = 'u1';
const params = { params: Promise.resolve({ id: TARGET }) };

function req(body: unknown) {
  return { json: () => Promise.resolve(body) } as never;
}

describe('POST /api/users/[id]/hard-delete', () => {
  beforeEach(() => {
    authMock.mockReset();
    createDbMock.mockReset().mockReturnValue({});
    isSuperadminMock.mockReset().mockResolvedValue(true);
    hardDeleteUserMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      workspaceService: { isSuperadmin: isSuperadminMock },
      userService: { hardDeleteUser: hardDeleteUserMock },
    });
  });

  it('returns 401 without a session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await POST(req({ confirmName: 'Alice' }), params);
    expect(res.status).toBe(401);
    expect(hardDeleteUserMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not a superadmin', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    isSuperadminMock.mockResolvedValueOnce(false);
    const res = await POST(req({ confirmName: 'Alice' }), params);
    expect(res.status).toBe(403);
    expect(hardDeleteUserMock).not.toHaveBeenCalled();
  });

  it('returns 400 when confirmName is missing', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    const res = await POST(req({}), params);
    expect(res.status).toBe(400);
    expect(hardDeleteUserMock).not.toHaveBeenCalled();
  });

  it('deletes the user with the caller id and typed name', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    const data = { id: TARGET, name: 'Alice' };
    hardDeleteUserMock.mockResolvedValueOnce(data);
    const res = await POST(req({ confirmName: 'Alice' }), params);
    expect(res.status).toBe(200);
    expect(hardDeleteUserMock).toHaveBeenCalledWith(USER_ID, TARGET, 'Alice');
    expect(await res.json()).toEqual({ data });
  });

  it.each([
    [new UserNotFoundError(TARGET), 404],
    [new CannotDeleteSelfError(), 400],
    [new DeleteConfirmationMismatchError(), 400],
    [new UserNotDeactivatedError(), 409],
    [new UserHasRetainedHistoryError(), 409],
  ])('maps %s to %i', async (error, status) => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    hardDeleteUserMock.mockRejectedValueOnce(error);
    const res = await POST(req({ confirmName: 'Alice' }), params);
    expect(res.status).toBe(status);
  });

  it('returns 500 on an unexpected error', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    vi.spyOn(console, 'error').mockImplementationOnce(() => {});
    hardDeleteUserMock.mockRejectedValueOnce(new Error('boom'));
    const res = await POST(req({ confirmName: 'Alice' }), params);
    expect(res.status).toBe(500);
  });
});
