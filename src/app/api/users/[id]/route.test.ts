import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  authMock,
  createDbMock,
  createContainerMock,
  isSuperadminMock,
  updateProfileMock,
  deactivateUserMock,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  createDbMock: vi.fn(),
  createContainerMock: vi.fn(),
  isSuperadminMock: vi.fn(),
  updateProfileMock: vi.fn(),
  deactivateUserMock: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));

import { PATCH, DELETE } from './route';
import { CannotDeactivateSelfError, UserNotFoundError } from '@/lib/services/userService';

const ACTOR = 'admin-1';
const TARGET = 'u1';
const params = { params: Promise.resolve({ id: TARGET }) };

function jsonRequest(body: unknown): never {
  return { json: async () => body } as never;
}

describe('PATCH /api/users/[id]', () => {
  beforeEach(() => {
    authMock.mockReset();
    createDbMock.mockReset().mockReturnValue({});
    isSuperadminMock.mockReset().mockResolvedValue(true);
    updateProfileMock.mockReset();
    deactivateUserMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      workspaceService: { isSuperadmin: isSuperadminMock },
      userService: { updateProfile: updateProfileMock, deactivateUser: deactivateUserMock },
    });
  });

  it('returns 401 without a session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await PATCH(jsonRequest({ name: 'Alicia' }), params);
    expect(res.status).toBe(401);
    expect(updateProfileMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not a superadmin', async () => {
    authMock.mockResolvedValueOnce({ user: { id: ACTOR } });
    isSuperadminMock.mockResolvedValueOnce(false);
    const res = await PATCH(jsonRequest({ name: 'Alicia' }), params);
    expect(res.status).toBe(403);
    expect(updateProfileMock).not.toHaveBeenCalled();
  });

  it('updates the profile and returns the admin projection', async () => {
    authMock.mockResolvedValueOnce({ user: { id: ACTOR } });
    const data = { id: TARGET, name: 'Alicia', email: 'a@x.com' };
    updateProfileMock.mockResolvedValueOnce(data);
    const res = await PATCH(jsonRequest({ name: 'Alicia' }), params);
    expect(res.status).toBe(200);
    expect(updateProfileMock).toHaveBeenCalledWith(TARGET, { name: 'Alicia', email: undefined });
    expect(await res.json()).toEqual({ data });
  });
});

describe('DELETE /api/users/[id]', () => {
  beforeEach(() => {
    authMock.mockReset();
    createDbMock.mockReset().mockReturnValue({});
    isSuperadminMock.mockReset().mockResolvedValue(true);
    updateProfileMock.mockReset();
    deactivateUserMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      workspaceService: { isSuperadmin: isSuperadminMock },
      userService: { updateProfile: updateProfileMock, deactivateUser: deactivateUserMock },
    });
  });

  it('returns 401 without a session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await DELETE({} as never, params);
    expect(res.status).toBe(401);
    expect(deactivateUserMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not a superadmin', async () => {
    authMock.mockResolvedValueOnce({ user: { id: ACTOR } });
    isSuperadminMock.mockResolvedValueOnce(false);
    const res = await DELETE({} as never, params);
    expect(res.status).toBe(403);
    expect(deactivateUserMock).not.toHaveBeenCalled();
  });

  it('deactivates the user as the session actor', async () => {
    authMock.mockResolvedValueOnce({ user: { id: ACTOR } });
    const data = { id: TARGET, deactivated_at: '2026-09-16T00:00:00.000Z' };
    deactivateUserMock.mockResolvedValueOnce(data);
    const res = await DELETE({} as never, params);
    expect(res.status).toBe(200);
    expect(deactivateUserMock).toHaveBeenCalledWith(ACTOR, TARGET);
    expect(await res.json()).toEqual({ data });
  });

  it('returns 400 when the actor tries to deactivate themselves', async () => {
    authMock.mockResolvedValueOnce({ user: { id: ACTOR } });
    deactivateUserMock.mockRejectedValueOnce(new CannotDeactivateSelfError());
    const res = await DELETE({} as never, { params: Promise.resolve({ id: ACTOR }) });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown user', async () => {
    authMock.mockResolvedValueOnce({ user: { id: ACTOR } });
    deactivateUserMock.mockRejectedValueOnce(new UserNotFoundError('nope'));
    const res = await DELETE({} as never, params);
    expect(res.status).toBe(404);
  });
});
