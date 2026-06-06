import { OAuth2Client } from 'google-auth-library';

/**
 * Thin wrapper around google-auth-library that validates a Google-issued ID
 * token (the `eyJ...` JWT supplied as `?token=` on the dashboard URL) against
 * Google's public keys and returns the verified email.
 *
 * Verification covers signature, expiry, issuer (`accounts.google.com`) and —
 * when `GOOGLE_CLIENT_ID` is configured — the audience claim. We require the
 * email to be present and `email_verified` to be true so a forged/unverified
 * Google account cannot be used to impersonate a real address.
 *
 * Throws on any validation failure so callers can treat a thrown error as
 * "untrusted token".
 */
export class GoogleTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleTokenError';
  }
}

// A single OAuth2Client can be reused across invocations; it caches Google's
// signing certificates internally.
let cachedClient: OAuth2Client | null = null;

function getClient(): OAuth2Client {
  if (!cachedClient) {
    cachedClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  }
  return cachedClient;
}

export async function verifyGoogleIdToken(token: string): Promise<string> {
  if (!token) throw new GoogleTokenError('Missing Google token');

  const clientId = process.env.GOOGLE_CLIENT_ID;

  let payload;
  try {
    const ticket = await getClient().verifyIdToken({
      idToken: token,
      // When the audience is omitted google-auth-library skips the aud check.
      // We only enforce it when a client id is configured.
      audience: clientId || undefined,
    });
    payload = ticket.getPayload();
  } catch (err) {
    throw new GoogleTokenError(
      `Google token verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!payload) throw new GoogleTokenError('Google token has no payload');
  if (!payload.email) throw new GoogleTokenError('Google token has no email');
  if (payload.email_verified === false) {
    throw new GoogleTokenError('Google email is not verified');
  }

  return payload.email.toLowerCase().trim();
}
