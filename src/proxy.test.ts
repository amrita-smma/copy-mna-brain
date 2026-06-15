import { describe, it, expect, vi } from 'vitest';

// The proxy module instantiates a NextAuth middleware instance at import time.
// Stub it so importing `classifyApiRoute` doesn't require the full auth/edge
// runtime — we only exercise the pure routing logic here.
vi.mock('next-auth', () => ({
  default: () => ({ auth: (handler: unknown) => handler }),
}));
vi.mock('@/auth.config', () => ({ authConfig: {} }));

import { classifyApiRoute } from './proxy';

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
