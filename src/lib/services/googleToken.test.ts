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

  const EXTERNAL_CLIENT_IDS = [
    '225311131378-194cggar6d82as0lc68v85au6tp9bdml.apps.googleusercontent.com',
    '129686335732-pholdt78pdlh3m5gu0vk4s2sg4c1o79c.apps.googleusercontent.com',
  ];

  it('returns the normalized email for a valid verified token', async () => {
    getPayloadMock.mockReturnValue({ email: ' User@Example.COM ', email_verified: true });
    await expect(verifyGoogleIdToken('good-token')).resolves.toBe('user@example.com');
    expect(verifyIdTokenMock).toHaveBeenCalledWith({
      idToken: 'good-token',
      audience: ['client-123.apps.googleusercontent.com', ...EXTERNAL_CLIENT_IDS],
    });
  });

  it('accepts the external ?token client ids alongside GOOGLE_CLIENT_ID', async () => {
    getPayloadMock.mockReturnValue({ email: 'user@example.com', email_verified: true });
    await verifyGoogleIdToken('external-token');
    const { audience } = verifyIdTokenMock.mock.calls[0][0];
    expect(audience).toEqual(
      expect.arrayContaining(['client-123.apps.googleusercontent.com', ...EXTERNAL_CLIENT_IDS]),
    );
  });

  it('still enforces the external audiences when GOOGLE_CLIENT_ID is unset', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    getPayloadMock.mockReturnValue({ email: 'user@example.com', email_verified: true });
    await verifyGoogleIdToken('external-token');
    expect(verifyIdTokenMock).toHaveBeenCalledWith({
      idToken: 'external-token',
      audience: EXTERNAL_CLIENT_IDS,
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
