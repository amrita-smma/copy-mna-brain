import { describe, it, expect, vi } from 'vitest';

// The proxy module instantiates a NextAuth middleware instance at import time.
// Stub it so importing `classifyApiRoute` doesn't require the full auth/edge
// runtime — we only exercise the pure routing logic here.
vi.mock('next-auth', () => ({
  default: () => ({ auth: (handler: unknown) => handler }),
}));
vi.mock('@/auth.config', () => ({ authConfig: {} }));

import {
  classifyApiRoute,
  extractRefererWorkspaceSlug,
  extractWorkspaceSlug,
  isValidWorkspaceSlug,
  proxy,
} from './proxy';

const ORIGIN = 'https://brain.test';

/**
 * Runs the middleware against a minimal stand-in for the authed NextRequest it
 * normally receives. The `next-auth` mock above makes `proxy` the bare handler,
 * so it can be driven directly with just the fields the `/w/` branch reads.
 */
function runProxy(path: string, auth: unknown = null): { headers: Headers } {
  const url = new URL(path, ORIGIN);
  const req = {
    url: url.toString(),
    nextUrl: url,
    auth,
    headers: new Headers(),
    cookies: { has: () => false },
  };
  const handler = proxy as unknown as (r: unknown) => { headers: Headers };
  return handler(req);
}

/** The `Location` of a redirect response, relative to the app origin. */
function locationOf(res: { headers: Headers }): string {
  return (res.headers.get('location') ?? '').replace(ORIGIN, '');
}

describe('proxy /w/ authentication gate', () => {
  it('preserves the deeplinked path as a callbackUrl when redirecting to login', () => {
    const res = runProxy('/w/togan-vcc/pipeline/deal-123');
    expect(locationOf(res)).toBe('/login?callbackUrl=%2Fw%2Ftogan-vcc%2Fpipeline%2Fdeal-123');
  });

  it("preserves the deeplink's query string too", () => {
    const res = runProxy('/w/togan-vcc/pipeline?stage=L0');
    expect(locationOf(res)).toBe('/login?callbackUrl=%2Fw%2Ftogan-vcc%2Fpipeline%3Fstage%3DL0');
  });

  it('routes an SSO deeplink to the token handler rather than the login bounce', () => {
    // The `?token=` branch runs before the auth gate, so a launcher deeplink
    // establishes its session instead of being sent to /login.
    const res = runProxy('/w/togan-vcc/chat?token=jwt123&tab=notes');
    expect(locationOf(res)).toBe(
      '/api/auth/sso?token=jwt123&callbackUrl=%2Fw%2Ftogan-vcc%2Fchat%3Ftab%3Dnotes',
    );
  });

  it('does not hijack /reset-password?token=... into the SSO deeplink handler', () => {
    // reset_password_tokens are opaque hex strings, not Google/launcher JWTs —
    // routing them through /api/auth/sso would fail verification and bounce
    // the user to /login instead of the set-password form (see reset-password
    // page.tsx, which reads this same `token` query param itself).
    const res = runProxy('/reset-password?token=9874664851809f38aa37e337a7eb2522193cb741');
    expect(res.headers.get('location')).toBeNull();
  });

  it('still bounces an authenticated non-member to the picker, not the deeplink', () => {
    const res = runProxy('/w/other-tenant/pipeline', {
      user: { id: 'u1', isSuperadmin: false, workspaces: [{ slug: 'togan-vcc' }], hasConsented: true },
    });
    expect(locationOf(res)).toBe('/workspace');
  });

  it('injects the request path for the layout to build its own callback URL', () => {
    const res = runProxy('/w/togan-vcc/pipeline?stage=L0', {
      user: { id: 'u1', isSuperadmin: false, workspaces: [{ slug: 'togan-vcc' }], hasConsented: true },
    });
    // `NextResponse.next({ request: { headers } })` surfaces overrides here.
    expect(res.headers.get('x-middleware-override-headers')).toContain('x-pathname');
    expect(res.headers.get('x-middleware-request-x-pathname')).toBe('/w/togan-vcc/pipeline?stage=L0');
  });
});

describe('proxy /w/ consent gate', () => {
  it('bounces an authenticated-but-unconsented user to /consent, preserving the deeplink', () => {
    const res = runProxy('/w/togan-vcc/pipeline?stage=L0', {
      user: { id: 'u1', isSuperadmin: false, workspaces: [{ slug: 'togan-vcc' }], hasConsented: false },
    });
    expect(locationOf(res)).toBe('/consent?callbackUrl=%2Fw%2Ftogan-vcc%2Fpipeline%3Fstage%3DL0');
  });

  it('checks consent before slug membership, so an unconsented non-member also lands on /consent', () => {
    const res = runProxy('/w/other-tenant/pipeline', {
      user: { id: 'u1', isSuperadmin: false, workspaces: [{ slug: 'togan-vcc' }], hasConsented: false },
    });
    expect(locationOf(res)).toBe('/consent?callbackUrl=%2Fw%2Fother-tenant%2Fpipeline');
  });

  it('lets a consented member through to the slug/header-injection logic', () => {
    const res = runProxy('/w/togan-vcc/pipeline', {
      user: { id: 'u1', isSuperadmin: false, workspaces: [{ slug: 'togan-vcc' }], hasConsented: true },
    });
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('classifyApiRoute', () => {
  it('gates the admin signup route on the shared secret', () => {
    expect(classifyApiRoute('/api/auth/signup')).toBe('secret');
  });

  it('gates the admin api-keys collection on the shared secret', () => {
    expect(classifyApiRoute('/api/auth/api-keys')).toBe('secret');
  });

  it('gates an individual admin api-key on the shared secret', () => {
    expect(classifyApiRoute('/api/auth/api-keys/abc-123')).toBe('secret');
  });

  it('leaves the NextAuth core surface public', () => {
    expect(classifyApiRoute('/api/auth/session')).toBe('allow');
    expect(classifyApiRoute('/api/auth/callback/credentials')).toBe('allow');
    expect(classifyApiRoute('/api/auth/csrf')).toBe('allow');
  });

  it('leaves the public password-reset flows public', () => {
    expect(classifyApiRoute('/api/auth/forget-password')).toBe('allow');
    expect(classifyApiRoute('/api/auth/reset-password')).toBe('allow');
  });

  it('leaves the liveness probe public', () => {
    expect(classifyApiRoute('/api/healthcheck')).toBe('allow');
  });

  it('leaves self-authenticated route families public', () => {
    expect(classifyApiRoute('/api/v1/chat')).toBe('allow');
    expect(classifyApiRoute('/api/v1/chat/stream')).toBe('allow');
    expect(classifyApiRoute('/api/cron/dispatch')).toBe('allow');
    expect(classifyApiRoute('/api/cron/cleanup-jobs')).toBe('allow');
    expect(classifyApiRoute('/api/queues/send-email')).toBe('allow');
  });

  it('requires a user session for regular dashboard routes', () => {
    expect(classifyApiRoute('/api/companies')).toBe('session');
    expect(classifyApiRoute('/api/companies/123/financials')).toBe('session');
    expect(classifyApiRoute('/api/crm')).toBe('session');
    expect(classifyApiRoute('/api/crm/employers/42/notes')).toBe('session');
    expect(classifyApiRoute('/api/screenings')).toBe('session');
    expect(classifyApiRoute('/api/users')).toBe('session');
  });
});

describe('extractWorkspaceSlug', () => {
  it('extracts the slug from a /w/<slug>/... pathname', () => {
    expect(extractWorkspaceSlug('/w/togan-vcc/pipeline')).toBe('togan-vcc');
  });

  it('extracts the slug when the pathname is just /w/<slug>', () => {
    expect(extractWorkspaceSlug('/w/togan-vcc')).toBe('togan-vcc');
  });

  it('returns null for a non-/w/ pathname', () => {
    expect(extractWorkspaceSlug('/api/companies')).toBeNull();
  });
});

describe('isValidWorkspaceSlug', () => {
  it('matches a real membership', () => {
    expect(isValidWorkspaceSlug('togan-vcc', [{ slug: 'togan-vcc' }], false)).toBe(true);
  });

  it('rejects a slug not in the membership list', () => {
    expect(isValidWorkspaceSlug('aeliana-vcc', [{ slug: 'togan-vcc' }], false)).toBe(false);
  });

  it('grants implicit access to a superadmin regardless of membership', () => {
    expect(isValidWorkspaceSlug('any-workspace', [], true)).toBe(true);
  });

  it('rejects an empty membership list for a non-superadmin', () => {
    expect(isValidWorkspaceSlug('togan-vcc', [], false)).toBe(false);
  });
});

describe('extractRefererWorkspaceSlug', () => {
  const host = 'app.example.com';

  it('extracts the slug from a same-host /w/<slug>/... referer', () => {
    expect(
      extractRefererWorkspaceSlug(`https://${host}/w/togan-vcc/pipeline`, host),
    ).toBe('togan-vcc');
  });

  it('returns null when there is no referer', () => {
    expect(extractRefererWorkspaceSlug(null, host)).toBeNull();
  });

  it('returns null when there is no request host', () => {
    expect(extractRefererWorkspaceSlug(`https://${host}/w/togan-vcc/pipeline`, null)).toBeNull();
  });

  it('returns null for a cross-host referer, even if it looks workspace-scoped', () => {
    expect(
      extractRefererWorkspaceSlug('https://evil.example.com/w/togan-vcc/pipeline', host),
    ).toBeNull();
  });

  it('matches by host regardless of scheme, mirroring TLS-terminating reverse proxies', () => {
    expect(
      extractRefererWorkspaceSlug(`http://${host}/w/togan-vcc/pipeline`, host),
    ).toBe('togan-vcc');
  });

  it('returns null for a same-host referer that is not workspace-scoped', () => {
    expect(extractRefererWorkspaceSlug(`https://${host}/workspace`, host)).toBeNull();
  });

  it('returns null for a malformed referer', () => {
    expect(extractRefererWorkspaceSlug('not-a-url', host)).toBeNull();
  });
});

describe('classifyApiRoute — rss feed admin routes', () => {
  it('gates the rss-feeds collection behind the shared secret', () => {
    expect(classifyApiRoute('/api/auth/rss-feeds')).toBe('secret');
  });

  it('gates rss-feeds sub-paths behind the shared secret', () => {
    expect(classifyApiRoute('/api/auth/rss-feeds/import')).toBe('secret');
    expect(classifyApiRoute('/api/auth/rss-feeds/abc-123')).toBe('secret');
  });

  it('leaves the rest of /api/auth open for NextAuth', () => {
    expect(classifyApiRoute('/api/auth/session')).toBe('allow');
  });
});
