import { OAuth2Client } from "google-auth-library";

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
    this.name = "GoogleTokenError";
  }
}

// OAuth client IDs whose tokens the external `?token=` deeplink feature may be
// issued for. Tokens minted by these clients carry one of these values in their
// `aud` claim, so they must be accepted alongside this app's own client id.
const EXTERNAL_TOKEN_CLIENT_IDS = [
  "225311131378-194cggar6d82as0lc68v85au6tp9bdml.apps.googleusercontent.com", // launcher staging
  "129686335732-pholdt78pdlh3m5gu0vk4s2sg4c1o79c.apps.googleusercontent.com", // launcher prod
];

// A single OAuth2Client can be reused across invocations; it caches Google's
// signing certificates internally.
let cachedClient: OAuth2Client | null = null;

function getClient(): OAuth2Client {
  if (!cachedClient) {
    cachedClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  }
  return cachedClient;
}

/**
 * Every OAuth client id a token may legitimately be issued for: this app's own
 * client (the login-page button, via `GOOGLE_CLIENT_ID`) plus the external
 * clients behind the `?token=` deeplink feature. Deduped so a valid token's
 * `aud` need only match one of them.
 */
function allowedAudiences(): string[] {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  return Array.from(
    new Set([...(clientId ? [clientId] : []), ...EXTERNAL_TOKEN_CLIENT_IDS]),
  );
}

export async function verifyGoogleIdToken(token: string): Promise<string> {
  if (!token) throw new GoogleTokenError("Missing Google token");

  const audience = allowedAudiences();

  let payload;
  try {
    const ticket = await getClient().verifyIdToken({
      idToken: token,
      // google-auth-library accepts a single value or an array and enforces
      // that the token's `aud` matches one of them. The array is never empty
      // (the external client ids are always present), so the aud check is
      // always enforced — an unset GOOGLE_CLIENT_ID does not disable it.
      audience,
    });
    payload = ticket.getPayload();
  } catch (err) {
    throw new GoogleTokenError(
      `Google token verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!payload) throw new GoogleTokenError("Google token has no payload");
  if (!payload.email) throw new GoogleTokenError("Google token has no email");
  if (payload.email_verified === false) {
    throw new GoogleTokenError("Google email is not verified");
  }

  return payload.email.toLowerCase().trim();
}
