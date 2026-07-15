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

/** Extracts the `<slug>` segment from a `/w/<slug>/...` pathname, or null if the path doesn't match. */
export function extractWorkspaceSlug(pathname: string): string | null {
  const match = pathname.match(/^\/w\/([^/]+)(?:\/|$)/);
  return match ? match[1] : null;
}

/**
 * Whether `slug` is one this user can enter — a real membership, or implicit
 * access via the platform-wide superadmin flag. Pure function, no DB access
 * (matches this file's existing edge-safe constraint): validated purely
 * against the JWT-embedded membership list from `session.user.workspaces`.
 */
export function isValidWorkspaceSlug(
  slug: string,
  workspaces: { slug: string }[],
  isSuperadmin: boolean,
): boolean {
  if (isSuperadmin) return true;
  return workspaces.some((w) => w.slug === slug);
}

/**
 * Extracts a same-origin `/w/<slug>/...` referer's slug, or null if the
 * referer is missing, cross-origin, or not a workspace-scoped path.
 */
export function extractRefererWorkspaceSlug(refererHeader: string | null, requestHost: string | null): string | null {
  if (!refererHeader) return null;
  try {
    const refererUrl = new URL(refererHeader);
    // Compare hosts, not full origins computed by the framework — behind a
    // reverse proxy or a Docker bind-to-0.0.0.0 setup, `req.nextUrl.origin`
    // reflects the internal bind address, not the externally-visible host
    // the browser actually sent the Referer against. The incoming `Host`
    // header is the value browsers keep in sync with the visible URL.
    if (refererUrl.host !== requestHost) return null;
    return extractWorkspaceSlug(refererUrl.pathname);
  } catch {
    return null;
  }
}

export const proxy = auth((req) => {
  const pathname = req.nextUrl.pathname;

  if (pathname.startsWith('/w/')) {
    if (!req.auth?.user?.id) {
      // Preserve a Google SSO token so GoogleSsoTokenGate can exchange it on
      // the login page — without this a deeplink to /w/<slug>/*?token=... drops
      // the token and the auto-sign-in link becomes a plain redirect to /login.
      const loginUrl = new URL('/login', req.url);
      const token = req.nextUrl.searchParams.get('token');
      if (token) loginUrl.searchParams.set('token', token);
      return NextResponse.redirect(loginUrl);
    }

    const slug = extractWorkspaceSlug(pathname);
    const workspaces = req.auth.user.workspaces ?? [];
    if (!slug || !isValidWorkspaceSlug(slug, workspaces, req.auth.user.isSuperadmin)) {
      return NextResponse.redirect(new URL('/workspace', req.url));
    }

    // Inject (not merely forward) X-Workspace-Slug from the validated URL —
    // this is what makes `getActiveWorkspaceId()`'s header check work for
    // document/RSC requests, which never go through `apiRequest`'s client-side
    // header injection. Setting it here, from the already-authenticated URL,
    // also means a client can never spoof this header on a page request.
    const requestHeaders = new Headers(req.headers);
    requestHeaders.set('X-Workspace-Slug', slug);
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  const mode = classifyApiRoute(pathname);
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
  if (!hasSession && !hasValidSecret) return unauthorized();

  // Net for the client-side fetch sweep: a same-origin caller's own URL
  // already proves which workspace it's scoped to. If the request didn't
  // already carry an explicit header (apiRequest's client-side injection,
  // or a call site not yet converted), derive it from the Referer instead
  // of relying on every call site being swept. Still validated against
  // membership and still fails closed downstream in getActiveWorkspaceId()
  // — this only ever narrows scope, never widens it.
  const hasExplicitWorkspaceHeader =
    req.headers.has('x-workspace-slug') || req.headers.has('x-workspace-id');
  if (!hasExplicitWorkspaceHeader && req.auth?.user) {
    const refererSlug = extractRefererWorkspaceSlug(req.headers.get('referer'), req.headers.get('host'));
    const workspaces = req.auth.user.workspaces ?? [];
    if (refererSlug && isValidWorkspaceSlug(refererSlug, workspaces, req.auth.user.isSuperadmin)) {
      const requestHeaders = new Headers(req.headers);
      requestHeaders.set('X-Workspace-Slug', refererSlug);
      return NextResponse.next({ request: { headers: requestHeaders } });
    }
    if (process.env.NODE_ENV !== 'production') {
      const referer = req.headers.get('referer') ?? '';
      if (referer.includes('/w/')) {
        console.warn(
          `[proxy] ${pathname} received no X-Workspace-Slug header and its Referer (${referer}) could not be resolved to a valid membership — this request will fall back to the session's active workspace instead of the calling tab's own workspace. Likely an unconverted fetch() call site or a stripped Referer.`,
        );
      }
    }
  }

  return NextResponse.next();
});

// Gate every API route, plus workspace-scoped page routes (membership check +
// header injection — see the `/w/` branch above). Other page routes are
// unaffected (they enforce auth in their own server components). New
// `/api/*` routes are protected by default — add them to `classifyApiRoute`
// only if they need to be public or self-authed.
export const config = {
  matcher: ['/api/:path*', '/w/:path*'],
};
