import { jwtVerify, createRemoteJWKSet } from "jose";

/**
 * Verifies a launcher-signed RS256 JWT handed to this app via the `?token=`
 * query parameter. The token is issued by the Brain Launcher and signed with
 * its private RS256 key — we verify it against the launcher's JWKS endpoint.
 *
 * Verification covers:
 *  - Signature (RS256 only, via JWKS — key rotation is transparent via kid lookup)
 *  - Expiry (`exp` claim — jose checks this automatically)
 *  - Issuer (`iss` must equal `LAUNCHER_ORIGIN`)
 *  - Audience (`aud` must equal this app's own origin, `NEXT_PUBLIC_APP_URL`)
 *  - Email present in payload
 *
 * Throws `LauncherTokenError` on any failure so callers can treat a thrown
 * error as "untrusted token".
 */
export class LauncherTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LauncherTokenError";
  }
}

// Lazy singleton — initialised on first call so that (a) a missing
// LAUNCHER_ORIGIN throws a descriptive error at call time rather than module
// load time, and (b) tests can set the env var before the first invocation.
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!_jwks) {
    const origin = process.env.LAUNCHER_ORIGIN;
    if (!origin)
      throw new LauncherTokenError("LAUNCHER_ORIGIN is not configured");
    _jwks = createRemoteJWKSet(new URL(`${origin}/.well-known/jwks.json`));
  }
  return _jwks;
}

export async function verifyLauncherToken(
  token: string,
): Promise<{ email: string; name?: string }> {
  if (!token) throw new LauncherTokenError("Missing launcher token");

  const audience = process.env.NEXT_PUBLIC_APP_URL;
  if (!audience)
    throw new LauncherTokenError("NEXT_PUBLIC_APP_URL is not configured");

  const issuer = process.env.LAUNCHER_ORIGIN;
  if (!issuer)
    throw new LauncherTokenError("LAUNCHER_ORIGIN is not configured");

  try {
    const { payload } = await jwtVerify(token, getJwks(), {
      issuer,
      audience,
      algorithms: ["RS256"],
    });

    if (!payload.email || typeof payload.email !== "string") {
      throw new LauncherTokenError("launcher token missing email");
    }

    return {
      email: payload.email.toLowerCase().trim(),
      name: typeof payload.name === "string" ? payload.name : undefined,
    };
  } catch (err) {
    if (err instanceof LauncherTokenError) throw err;
    throw new LauncherTokenError(
      `Launcher token verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
