import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyIdTokenMock, getPayloadMock } = vi.hoisted(() => ({
  verifyIdTokenMock: vi.fn(),
  getPayloadMock: vi.fn(),
}));

vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken = verifyIdTokenMock;
  },
}));

import { GoogleTokenError, verifyGoogleIdToken } from './googleToken';

describe('verifyGoogleIdToken', () => {
  const ORIGINAL_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

  beforeEach(() => {
    verifyIdTokenMock.mockReset();
    getPayloadMock.mockReset();
    verifyIdTokenMock.mockResolvedValue({ getPayload: getPayloadMock });
    process.env.GOOGLE_CLIENT_ID = 'client-123.apps.googleusercontent.com';
  });

  afterEach(() => {
    process.env.GOOGLE_CLIENT_ID = ORIGINAL_CLIENT_ID;
    vi.clearAllMocks();
  });

  it('throws without calling Google when the token is empty', async () => {
    await expect(verifyGoogleIdToken('')).rejects.toBeInstanceOf(GoogleTokenError);
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it('returns the normalized email for a valid verified token', async () => {
    getPayloadMock.mockReturnValue({ email: ' User@Example.COM ', email_verified: true });
    await expect(verifyGoogleIdToken('good-token')).resolves.toBe('user@example.com');
    expect(verifyIdTokenMock).toHaveBeenCalledWith({
      idToken: 'good-token',
      audience: 'client-123.apps.googleusercontent.com',
    });
  });

  it('wraps a Google verification failure in a GoogleTokenError', async () => {
    verifyIdTokenMock.mockRejectedValue(new Error('Invalid token signature'));
    await expect(verifyGoogleIdToken('bad-token')).rejects.toThrow(/Invalid token signature/);
    await expect(verifyGoogleIdToken('bad-token')).rejects.toBeInstanceOf(GoogleTokenError);
  });

  it('throws when the payload has no email', async () => {
    getPayloadMock.mockReturnValue({ email_verified: true });
    await expect(verifyGoogleIdToken('no-email')).rejects.toThrow('Google token has no email');
  });

  it('throws when the email is not verified', async () => {
    getPayloadMock.mockReturnValue({ email: 'user@example.com', email_verified: false });
    await expect(verifyGoogleIdToken('unverified')).rejects.toThrow('Google email is not verified');
  });

  it('throws when the payload is empty', async () => {
    getPayloadMock.mockReturnValue(undefined);
    await expect(verifyGoogleIdToken('empty')).rejects.toThrow('Google token has no payload');
  });
});
