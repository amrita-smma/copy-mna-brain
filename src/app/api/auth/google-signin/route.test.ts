import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UserNotRegisteredError } from '@/lib/services/authService';

const { createDbMock, signInWithGoogleTokenMock } = vi.hoisted(() => ({
  createDbMock: vi.fn(),
  signInWithGoogleTokenMock: vi.fn(),
}));

vi.mock('@/lib/server/db', () => ({ createDb: createDbMock }));
vi.mock('@/lib/services', () => ({
  createContainer: () => ({
    authService: { signInWithGoogleToken: signInWithGoogleTokenMock },
  }),
}));

import { POST } from './route';

function makeRequest(body: unknown): never {
  return { json: async () => body } as never;
}

describe('POST /api/auth/google-signin', () => {
  beforeEach(() => {
    createDbMock.mockReset().mockReturnValue({});
    signInWithGoogleTokenMock.mockReset();
  });

  it('returns 400 when the token is missing', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect(signInWithGoogleTokenMock).not.toHaveBeenCalled();
  });

  it('returns 400 when the token is not a string', async () => {
    const res = await POST(makeRequest({ token: 123 }));
    expect(res.status).toBe(400);
  });

  it('returns the verified email for a registered user', async () => {
    signInWithGoogleTokenMock.mockResolvedValueOnce({
      id: 'u1',
      email: 'user@example.com',
      name: 'User',
    });
    const res = await POST(makeRequest({ token: 'good-token' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ data: { email: 'user@example.com' } });
    expect(signInWithGoogleTokenMock).toHaveBeenCalledWith('good-token');
  });

  it('returns 403 with the exact message when the user is not registered', async () => {
    signInWithGoogleTokenMock.mockRejectedValueOnce(new UserNotRegisteredError());
    const res = await POST(makeRequest({ token: 'good-token' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe(
      'Your user is not registered in the system, please contact the MnA team',
    );
  });

  it('returns 401 when the Google token is invalid', async () => {
    signInWithGoogleTokenMock.mockRejectedValueOnce(new Error('Google token verification failed'));
    const res = await POST(makeRequest({ token: 'bad-token' }));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Google sign-in failed');
  });

  it('returns 500 when the request body is not valid JSON', async () => {
    const res = await POST({
      json: async () => {
        throw new Error('bad json');
      },
    } as never);
    expect(res.status).toBe(500);
  });
});
