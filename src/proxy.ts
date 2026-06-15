import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from '@/auth.config';

// Middleware-only NextAuth instance. It carries no providers (those live in
// `src/auth.ts` and touch the DB) — here we only read and verify the JWT
// session cookie to know whether the caller is a logged-in user.
const { auth } = NextAuth(authConfig);

/**
 * How a given `/api/*` path must be authenticated:
 * - `allow`   — public or self-authenticated in the handler (NextAuth core,
 *               password-reset flows, the external API-key surface, cron and
 *               queue consumer routes, the liveness probe). The gate lets it
 *               through untouched.
 * - `secret`  — privileged machine-to-machine admin route, gated by the
 *               shared `ADMIN_SECRET` via the `X-Api-Secret` header.
 * - `session` — regular dashboard route. Requires a logged-in user session,
 *               or a valid `X-Api-Secret` for internal server-to-server calls
 *               made through `src/lib/api/client.ts`.
 */
export type ApiAuthMode = 'allow' | 'secret' | 'session';

const ADMIN_ROUTES = new Set(['/api/auth/signup', '/api/auth/api-keys']);

// Prefixes whose routes authenticate themselves inside the handler (API key,
// CRON_SECRET) or are private Vercel queue triggers with no public URL.
const SELF_AUTHED_PREFIXES = ['/api/v1/', '/api/cron/', '/api/queues/'];

export function classifyApiRoute(pathname: string): ApiAuthMode {
  // Admin (shared-secret) routes must be checked before the generic
  // `/api/auth/` passthrough below, since they live under that prefix.
  if (ADMIN_ROUTES.has(pathname) || pathname.startsWith('/api/auth/api-keys/')) {
    return 'secret';
  }

  // Liveness probe — must answer without a session for load balancers.
  if (pathname === '/api/healthcheck') return 'allow';

  // Everything else under `/api/auth/` is the NextAuth core surface
  // (session, csrf, signin, callback, ...) plus the public password-reset
  // flows (forget-password, reset-password). These must stay open.
  if (pathname.startsWith('/api/auth/')) return 'allow';

  if (SELF_AUTHED_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return 'allow';
  }

  if (pathname.startsWith('/api/')) return 'session';

  // The matcher only targets `/api/*`, so this is unreachable in practice.
  return 'allow';
}

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export const proxy = auth((req) => {
  const mode = classifyApiRoute(req.nextUrl.pathname);
  if (mode === 'allow') return NextResponse.next();

  const expectedSecret = process.env.ADMIN_SECRET;
  const providedSecret = req.headers.get('x-api-secret');
  const hasValidSecret =
    Boolean(expectedSecret) && providedSecret === expectedSecret;

  if (mode === 'secret') {
    return hasValidSecret ? NextResponse.next() : unauthorized();
  }

  // mode === 'session': a logged-in user, or an internal call carrying the
  // shared secret (server-to-server `apiRequest`).
  const hasSession = Boolean(req.auth?.user?.id);
  return hasSession || hasValidSecret ? NextResponse.next() : unauthorized();
});

// Gate every API route. Page routes are unaffected (they enforce auth in their
// own server components). New `/api/*` routes are protected by default — add
// them to `classifyApiRoute` only if they need to be public or self-authed.
export const config = {
  matcher: ['/api/:path*'],
};
