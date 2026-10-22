import { describe, it, expect } from 'vitest';
import { checkInternalSecret, internalApiBaseUrl, internalApiHeaders, internalApiUrl } from './internalApi';

describe('internalApiBaseUrl', () => {
  it('prefers an explicit INTERNAL_API_URL, without a trailing slash', () => {
    expect(internalApiBaseUrl({ INTERNAL_API_URL: 'https://internal.example/ ', VERCEL: '1', VERCEL_URL: 'x.vercel.app' })).toBe(
      'https://internal.example',
    );
  });

  it('uses the production domain on Vercel production and the deployment URL elsewhere on Vercel', () => {
    expect(
      internalApiBaseUrl({
        VERCEL: '1',
        VERCEL_ENV: 'production',
        VERCEL_PROJECT_PRODUCTION_URL: 'mna.example.com',
        VERCEL_URL: 'mna-abc123.vercel.app',
      }),
    ).toBe('https://mna.example.com');
    expect(internalApiBaseUrl({ VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: 'mna-abc123.vercel.app' })).toBe(
      'https://mna-abc123.vercel.app',
    );
  });

  it('falls back to the app URL variables, then localhost, off Vercel', () => {
    expect(internalApiBaseUrl({ APP_URL: 'http://app.local/' })).toBe('http://app.local');
    expect(internalApiBaseUrl({ NEXT_PUBLIC_APP_URL: 'http://pub.local' })).toBe('http://pub.local');
    expect(internalApiBaseUrl({ NEXTAUTH_URL: 'http://auth.local' })).toBe('http://auth.local');
    expect(internalApiBaseUrl({})).toBe('http://localhost:3000');
  });

  it('builds a route URL from the base', () => {
    expect(internalApiUrl('/api/internal/bot-messages', { APP_URL: 'http://app.local' })).toBe(
      'http://app.local/api/internal/bot-messages',
    );
  });
});

describe('internalApiHeaders', () => {
  it('sends JSON, the shared secret as X-Api-Secret and the protection bypass when they are set', () => {
    expect(internalApiHeaders({ ADMIN_SECRET: 's3', VERCEL_AUTOMATION_BYPASS_SECRET: 'byp' })).toEqual({
      'content-type': 'application/json',
      'x-api-secret': 's3',
      'x-vercel-protection-bypass': 'byp',
    });
  });

  it('sends only the content type when nothing is configured', () => {
    expect(internalApiHeaders({})).toEqual({ 'content-type': 'application/json' });
  });
});

describe('checkInternalSecret', () => {
  it('accepts the X-Api-Secret that matches ADMIN_SECRET and rejects anything else', () => {
    expect(checkInternalSecret('s3', { ADMIN_SECRET: 's3' })).toBe('ok');
    expect(checkInternalSecret('nope', { ADMIN_SECRET: 's3' })).toBe('unauthorized');
    expect(checkInternalSecret(null, { ADMIN_SECRET: 's3' })).toBe('unauthorized');
  });

  it('fails closed when no secret is configured', () => {
    expect(checkInternalSecret(null, {})).toBe('missing-secret');
    expect(checkInternalSecret('anything', {})).toBe('missing-secret');
  });
});
