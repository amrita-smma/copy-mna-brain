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
} from './proxy';

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
