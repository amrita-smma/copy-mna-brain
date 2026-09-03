import { describe, it, expect } from 'vitest';
import { CALLBACK_URL_PARAM, consentUrlWithCallback, loginUrlWithCallback, sanitizeCallbackUrl } from './callbackUrl';

describe('sanitizeCallbackUrl', () => {
  it('accepts a same-origin workspace-scoped path', () => {
    expect(sanitizeCallbackUrl('/w/togan-vcc/pipeline/deal-123')).toBe('/w/togan-vcc/pipeline/deal-123');
  });

  it('preserves the query string and hash of the intended destination', () => {
    expect(sanitizeCallbackUrl('/w/togan-vcc/pipeline?stage=L0#deal-9')).toBe(
      '/w/togan-vcc/pipeline?stage=L0#deal-9',
    );
  });

  it('returns null for an empty, null or undefined value', () => {
    expect(sanitizeCallbackUrl(null)).toBeNull();
    expect(sanitizeCallbackUrl(undefined)).toBeNull();
    expect(sanitizeCallbackUrl('')).toBeNull();
  });

  it('rejects an absolute URL on another host', () => {
    expect(sanitizeCallbackUrl('https://evil.example/steal')).toBeNull();
  });

  it('rejects a protocol-relative URL, which the browser resolves to another host', () => {
    expect(sanitizeCallbackUrl('//evil.example/steal')).toBeNull();
  });

  it('rejects a backslash-prefixed path, which some browsers normalise to //', () => {
    expect(sanitizeCallbackUrl('/\\evil.example/steal')).toBeNull();
    expect(sanitizeCallbackUrl('/\\/evil.example')).toBeNull();
  });

  it('rejects a path that does not start with a slash', () => {
    expect(sanitizeCallbackUrl('w/togan-vcc/chat')).toBeNull();
    expect(sanitizeCallbackUrl('javascript:alert(1)')).toBeNull();
  });

  it('rejects percent-encoded forms of the protocol-relative escapes', () => {
    // These stay same-origin under WHATWG Location resolution as they are, but
    // decode to `/\…` and `///…` — an open redirect for any consumer that
    // decodes once before redirecting.
    expect(sanitizeCallbackUrl('/%5Cevil.example')).toBeNull();
    expect(sanitizeCallbackUrl('/%5cevil.example')).toBeNull();
    expect(sanitizeCallbackUrl('/%5C%5Cevil.example')).toBeNull();
    expect(sanitizeCallbackUrl('/%2F%2Fevil.example')).toBeNull();
    expect(sanitizeCallbackUrl('/%2f%2fevil.example')).toBeNull();
  });

  it('rejects a value whose percent-encoding is malformed', () => {
    expect(sanitizeCallbackUrl('/w/%E0%A4%A')).toBeNull();
  });

  it('still accepts encoded slashes inside a query value, which are not an escape', () => {
    expect(sanitizeCallbackUrl('/w/togan-vcc/smart-files?path=%2Ffoo%2Fbar')).toBe(
      '/w/togan-vcc/smart-files?path=%2Ffoo%2Fbar',
    );
  });

  it('rejects a value containing control characters used to smuggle a host', () => {
    expect(sanitizeCallbackUrl('/\n//evil.example')).toBeNull();
    expect(sanitizeCallbackUrl('/w/a\tb')).toBeNull();
  });

  it('rejects the login page itself, so a bounced login cannot loop', () => {
    expect(sanitizeCallbackUrl('/login')).toBeNull();
    expect(sanitizeCallbackUrl('/login?callbackUrl=%2Flogin')).toBeNull();
  });

  it('rejects API paths, which are never a place to land a browser', () => {
    expect(sanitizeCallbackUrl('/api/auth/sso')).toBeNull();
    expect(sanitizeCallbackUrl('/api/companies')).toBeNull();
  });

  it('strips the SSO `token` param, which is consumed once in proxy.ts', () => {
    expect(sanitizeCallbackUrl('/w/togan-vcc/chat?token=abc&tab=notes')).toBe('/w/togan-vcc/chat?tab=notes');
    expect(sanitizeCallbackUrl('/w/togan-vcc/chat?token=abc')).toBe('/w/togan-vcc/chat');
  });

  it('accepts flat legacy paths, which the legacy bridge re-resolves after login', () => {
    expect(sanitizeCallbackUrl('/pipeline?stage=L0')).toBe('/pipeline?stage=L0');
  });
});

describe('loginUrlWithCallback', () => {
  it('appends the sanitized destination as an encoded query param', () => {
    expect(loginUrlWithCallback('/w/togan-vcc/pipeline/deal-123')).toBe(
      `/login?${CALLBACK_URL_PARAM}=%2Fw%2Ftogan-vcc%2Fpipeline%2Fdeal-123`,
    );
  });

  it('encodes a destination that itself carries a query string', () => {
    const url = loginUrlWithCallback('/w/togan-vcc/pipeline?stage=L0');
    expect(url).toBe(`/login?${CALLBACK_URL_PARAM}=%2Fw%2Ftogan-vcc%2Fpipeline%3Fstage%3DL0`);
    // Round-trips back to the original path through normal URL parsing.
    expect(new URL(url, 'https://brain.test').searchParams.get(CALLBACK_URL_PARAM)).toBe(
      '/w/togan-vcc/pipeline?stage=L0',
    );
  });

  it('returns a bare /login for an unsafe destination', () => {
    expect(loginUrlWithCallback('//evil.example')).toBe('/login');
    expect(loginUrlWithCallback('https://evil.example')).toBe('/login');
    expect(loginUrlWithCallback(null)).toBe('/login');
  });

  it('returns a bare /login for destinations the post-login default already covers', () => {
    expect(loginUrlWithCallback('/')).toBe('/login');
    expect(loginUrlWithCallback('/workspace')).toBe('/login');
  });
});

describe('consentUrlWithCallback', () => {
  it('appends the sanitized destination as an encoded query param', () => {
    expect(consentUrlWithCallback('/w/togan-vcc/pipeline/deal-123')).toBe(
      `/consent?${CALLBACK_URL_PARAM}=%2Fw%2Ftogan-vcc%2Fpipeline%2Fdeal-123`,
    );
  });

  it('encodes a destination that itself carries a query string', () => {
    const url = consentUrlWithCallback('/w/togan-vcc/pipeline?stage=L0');
    expect(url).toBe(`/consent?${CALLBACK_URL_PARAM}=%2Fw%2Ftogan-vcc%2Fpipeline%3Fstage%3DL0`);
  });

  it('returns a bare /consent for an unsafe destination', () => {
    expect(consentUrlWithCallback('//evil.example')).toBe('/consent');
    expect(consentUrlWithCallback('https://evil.example')).toBe('/consent');
    expect(consentUrlWithCallback(null)).toBe('/consent');
  });

  it('returns a bare /consent only when the destination is the redundant root path', () => {
    expect(consentUrlWithCallback('/')).toBe('/consent');
  });

  it('unlike loginUrlWithCallback, still preserves /workspace as a real destination', () => {
    expect(consentUrlWithCallback('/workspace')).toBe(`/consent?${CALLBACK_URL_PARAM}=%2Fworkspace`);
  });
});
