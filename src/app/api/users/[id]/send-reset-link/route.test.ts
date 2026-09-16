import { describe, it, expect, vi, beforeEach } from 'vitest';

const { authMock, createDbMock, createContainerMock, isSuperadminMock, sendResetLinkMock } =
  vi.hoisted(() => ({
    authMock: vi.fn(),
    createDbMock: vi.fn(),
    createContainerMock: vi.fn(),
    isSuperadminMock: vi.fn(),
    sendResetLinkMock: vi.fn(),
  }));

vi.mock('@/auth', () => ({ auth: authMock }));
vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services', () => ({ createContainer: createContainerMock }));

import { POST } from './route';
import { UserNotFoundError } from '@/lib/services/userService';

const USER_ID = 'admin-1';
const TARGET = 'u1';
const params = { params: Promise.resolve({ id: TARGET }) };

function makeRequest(origin = 'https://app.example.com'): never {
  return { nextUrl: { origin } } as never;
}

describe('POST /api/users/[id]/send-reset-link', () => {
  beforeEach(() => {
    authMock.mockReset();
    createDbMock.mockReset().mockReturnValue({});
    isSuperadminMock.mockReset().mockResolvedValue(true);
    sendResetLinkMock.mockReset();
    createContainerMock.mockReset().mockReturnValue({
      workspaceService: { isSuperadmin: isSuperadminMock },
      userService: { sendResetLink: sendResetLinkMock },
    });
  });

  it('returns 401 without a session', async () => {
    authMock.mockResolvedValueOnce(null);
    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(401);
    expect(sendResetLinkMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller is not a superadmin', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    isSuperadminMock.mockResolvedValueOnce(false);
    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(403);
    expect(sendResetLinkMock).not.toHaveBeenCalled();
  });

  it('sends a reset link using the request origin', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    sendResetLinkMock.mockResolvedValueOnce(undefined);
    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(200);
    expect(sendResetLinkMock).toHaveBeenCalledWith(TARGET, 'https://app.example.com');
    expect(await res.json()).toEqual({ data: { success: true } });
  });

  it('returns 404 for an unknown user', async () => {
    authMock.mockResolvedValueOnce({ user: { id: USER_ID } });
    sendResetLinkMock.mockRejectedValueOnce(new UserNotFoundError('nope'));
    const res = await POST(makeRequest(), params);
    expect(res.status).toBe(404);
  });
});
