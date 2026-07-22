import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Intercept `createRemoteJWKSet` at module level so the lazy singleton in
// launcherToken.ts picks up the mock instead of making a real HTTPS fetch.
const { mockJwksFn } = vi.hoisted(() => ({
  mockJwksFn: vi.fn(),
}));

vi.mock('jose', async (importOriginal) => {
  const jose = await importOriginal<typeof import('jose')>();
  return {
    ...jose,
    // Always return the same mock function so every `getJwks()` call uses it.
    createRemoteJWKSet: () => mockJwksFn,
  };
});

import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from 'jose';
import { LauncherTokenError, verifyLauncherToken } from './launcherToken';

const LAUNCHER_ORIGIN = 'https://brain.starcapital.co.id';
const BRAIN_ORIGIN = 'https://mna.sqe.co.id';

describe('verifyLauncherToken', () => {
  let privateKey: CryptoKey;
  const ORIGINAL_LAUNCHER = process.env.LAUNCHER_ORIGIN;
  const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

  beforeAll(async () => {
    process.env.LAUNCHER_ORIGIN = LAUNCHER_ORIGIN;
    process.env.NEXT_PUBLIC_APP_URL = BRAIN_ORIGIN;

    const keyPair = await generateKeyPair('RS256');
    privateKey = keyPair.privateKey;

    const pubJwk = await exportJWK(keyPair.publicKey);
    const localJwks = createLocalJWKSet({ keys: [pubJwk] });
    mockJwksFn.mockImplementation(
      (...args: Parameters<typeof localJwks>) => localJwks(...args),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    // Re-apply the implementation after clearAllMocks (which only clears call
    // history, not the implementation — but be explicit for clarity).
  });

  afterAll(() => {
    process.env.LAUNCHER_ORIGIN = ORIGINAL_LAUNCHER;
    process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
  });

  async function signToken(
    claims: Record<string, unknown>,
    opts: { alg?: string; key?: CryptoKey | Uint8Array } = {},
  ) {
    const alg = opts.alg ?? 'RS256';
    const key = opts.key ?? privateKey;
    return new SignJWT(claims)
      .setProtectedHeader({ alg })
      .sign(key as Parameters<SignJWT['sign']>[0]);
  }

  it('returns email and name for a valid RS256 launcher token', async () => {
    const token = await signToken({
      email: 'User@Example.COM',
      name: 'Test User',
      iss: LAUNCHER_ORIGIN,
      aud: BRAIN_ORIGIN,
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    const result = await verifyLauncherToken(token);
    expect(result.email).toBe('user@example.com');
    expect(result.name).toBe('Test User');
  });

  it('returns undefined name when the claim is absent', async () => {
    const token = await signToken({
      email: 'user@example.com',
      iss: LAUNCHER_ORIGIN,
      aud: BRAIN_ORIGIN,
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    const result = await verifyLauncherToken(token);
    expect(result.name).toBeUndefined();
  });

  it('throws LauncherTokenError for a wrong audience', async () => {
    const token = await signToken({
      email: 'user@example.com',
      iss: LAUNCHER_ORIGIN,
      aud: 'https://other-app.example.com',
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    await expect(verifyLauncherToken(token)).rejects.toBeInstanceOf(LauncherTokenError);
  });

  it('throws LauncherTokenError for a wrong issuer', async () => {
    const token = await signToken({
      email: 'user@example.com',
      iss: 'https://evil.example.com',
      aud: BRAIN_ORIGIN,
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    await expect(verifyLauncherToken(token)).rejects.toBeInstanceOf(LauncherTokenError);
  });

  it('throws LauncherTokenError for an expired token', async () => {
    const token = await signToken({
      email: 'user@example.com',
      iss: LAUNCHER_ORIGIN,
      aud: BRAIN_ORIGIN,
      exp: Math.floor(Date.now() / 1000) - 60, // 1 minute ago
    });

    await expect(verifyLauncherToken(token)).rejects.toBeInstanceOf(LauncherTokenError);
  });

  it('throws LauncherTokenError for a non-RS256 algorithm (HS256)', async () => {
    const hmacKey = new TextEncoder().encode('a-symmetric-secret-long-enough-for-hs256');
    const token = await signToken(
      {
        email: 'user@example.com',
        iss: LAUNCHER_ORIGIN,
        aud: BRAIN_ORIGIN,
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      { alg: 'HS256', key: hmacKey },
    );

    await expect(verifyLauncherToken(token)).rejects.toBeInstanceOf(LauncherTokenError);
  });

  it('throws LauncherTokenError when the email claim is absent', async () => {
    const token = await signToken({
      sub: 'user-id',
      iss: LAUNCHER_ORIGIN,
      aud: BRAIN_ORIGIN,
      exp: Math.floor(Date.now() / 1000) + 300,
    });

    await expect(verifyLauncherToken(token)).rejects.toThrow('launcher token missing email');
    await expect(verifyLauncherToken(token)).rejects.toBeInstanceOf(LauncherTokenError);
  });

  it('throws LauncherTokenError immediately for an empty token string', async () => {
    await expect(verifyLauncherToken('')).rejects.toThrow('Missing launcher token');
    await expect(verifyLauncherToken('')).rejects.toBeInstanceOf(LauncherTokenError);
  });
});
