import NextAuth from 'next-auth';
import { NextResponse } from 'next/server';
import { authConfig } from '@/auth.config';
import { loginUrlWithCallback, consentUrlWithCallback } from '@/lib/callbackUrl';

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

const ADMIN_ROUTES = new Set([
  '/api/auth/signup',
  '/api/auth/api-keys',
  '/api/auth/rss-feeds',
]);

// Prefixes whose routes authenticate themselves inside the handler (API key,
// CRON_SECRET) or are private Vercel queue triggers with no public URL.
const SELF_AUTHED_PREFIXES = ['/api/v1/', '/api/cron/', '/api/queues/'];

export function classifyApiRoute(pathname: string): ApiAuthMode {
  // Admin (shared-secret) routes must be checked before the generic
  // `/api/auth/` passthrough below, since they live under that prefix.
  if (
    ADMIN_ROUTES.has(pathname) ||
    pathname.startsWith('/api/auth/api-keys/') ||
    pathname.startsWith('/api/auth/rss-feeds/')
  ) {
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

  // Google-SSO deeplink. Any URL carrying `?token=` is a sign-in-and-land
  // request; consume it server-side exactly once by handing off to
  // `/api/auth/sso`, which validates the token, establishes the session, and
  // redirects to the clean destination. Doing this before any page renders is
  // what replaced the old client-side `GoogleSsoTokenGate` — whose in-render
  // soft redirects raced the app's other redirects and crashed the App Router.
  // The handler itself is excluded so it doesn't redirect to itself forever.
  const ssoToken = req.nextUrl.searchParams.get('token');
  if (ssoToken && pathname !== '/api/auth/sso') {
    const clean = new URL(req.url);
    clean.searchParams.delete('token');
    const ssoUrl = new URL('/api/auth/sso', req.url);
    ssoUrl.searchParams.set('token', ssoToken);
    ssoUrl.searchParams.set('callbackUrl', clean.pathname + clean.search);
    return NextResponse.redirect(ssoUrl);
  }

  if (pathname.startsWith('/w/')) {
    if (!req.auth?.user?.id) {
      // Not authenticated — send to login, carrying the URL they asked for so
      // signing in lands them on it instead of the workspace picker. Any
      // `?token` deeplink was already consumed above, and `loginUrlWithCallback`
      // strips a replayed one defensively. The slug is NOT validated here (we
      // have no membership list without a session) — after login the authed
      // pass through this same branch validates it and bounces a non-member to
      // `/workspace`, so an unauthorized slug can't be reached this way.
      return NextResponse.redirect(
        new URL(loginUrlWithCallback(pathname + req.nextUrl.search), req.url),
      );
    }

    // Consent gate: a logged-in user who hasn't accepted the Sync/Terms
    // consent screen can't reach any `/w/<slug>/...` page. Checked before slug
    // validation — an unconsented user shouldn't learn anything about
    // workspace membership before consenting. `/consent` itself isn't under
    // `/w/*`, so it's unaffected by this branch.
    if (!req.auth.user.hasConsented) {
      return NextResponse.redirect(
        new URL(consentUrlWithCallback(pathname + req.nextUrl.search), req.url),
      );
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
    // Server components have no way to read their own request path. The `/w/`
    // layout needs it to build a login callback URL if its own (defense-in-depth)
    // session check fails, so hand it down. Set, never forwarded, so a client
    // can't spoof it — and the layout sanitizes it regardless.
    requestHeaders.set('X-Pathname', pathname + req.nextUrl.search);
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  const mode = classifyApiRoute(pathname);
  if (mode === 'allow') return stripStaleCookiesIfNeeded(req, NextResponse.next());

  const expectedSecret = process.env.ADMIN_SECRET;
  const providedSecret = req.headers.get('x-api-secret');
  const hasValidSecret =
    Boolean(expectedSecret) && providedSecret === expectedSecret;

  if (mode === 'secret') {
    return hasValidSecret ? stripStaleCookiesIfNeeded(req, NextResponse.next()) : unauthorized();
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
      return stripStaleCookiesIfNeeded(req, NextResponse.next({ request: { headers: requestHeaders } }));
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

  return stripStaleCookiesIfNeeded(req, NextResponse.next());
});

function stripStaleCookiesIfNeeded(req: any, res: NextResponse): NextResponse {
  // If the request arrived with an auth cookie but NextAuth determined the user
  // is NOT logged in (e.g. JWTSessionError due to a rotated AUTH_SECRET),
  // aggressively delete the stale cookies on the way out so the browser doesn't
  // keep sending them and crashing NextAuth's client fetch wrappers.
  const hasAuthCookie =
    req.cookies.has('authjs.session-token') ||
    req.cookies.has('__Secure-authjs.session-token') ||
    req.cookies.has('next-auth.session-token') ||
    req.cookies.has('__Secure-next-auth.session-token');

  if (!req.auth?.user && hasAuthCookie) {
    res.cookies.delete('authjs.session-token');
    res.cookies.delete('__Secure-authjs.session-token');
    res.cookies.delete('next-auth.session-token');
    res.cookies.delete('__Secure-next-auth.session-token');
  }

  return res;
}

// Gate every API route, plus workspace-scoped page routes (membership check +
// header injection — see the `/w/` branch above). Other page routes are
// unaffected (they enforce auth in their own server components). New
// `/api/*` routes are protected by default — add them to `classifyApiRoute`
// only if they need to be public or self-authed.
export const config = {
  matcher: [
    '/api/:path*',
    '/w/:path*',
    // Also run on ANY other route when it carries a `?token` query, so a
    // Google-SSO deeplink (e.g. `/?token=...`, `/chat?token=...`) is consumed
    // server-side before a page renders. Excludes Next internals/static assets.
    {
      source: '/((?!_next/static|_next/image|favicon.ico).*)',
      has: [{ type: 'query', key: 'token' }],
    },
  ],
};
