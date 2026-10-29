import { describe, expect, it } from 'vitest';
import { DEFAULT_RETURN_PATH, resultUrl, safeReturnPath } from './returnTo';

describe('safeReturnPath', () => {
  it('keeps an in-app absolute path', () => {
    expect(safeReturnPath('/w/acme/profile?tab=you')).toBe('/w/acme/profile?tab=you');
  });

  it.each([null, undefined, '', 'w/acme', '//evil.com', '/\\evil.com', 'https://evil.com', '/w\n/x'])(
    'falls back to the default for %j',
    (value) => {
      expect(safeReturnPath(value as string | null | undefined)).toBe(DEFAULT_RETURN_PATH);
    },
  );
});

describe('resultUrl', () => {
  it('appends the outcome to the return path on the same origin', () => {
    const url = resultUrl('https://app.test', '/w/acme/profile?tab=you', 'connected');
    expect(url.origin).toBe('https://app.test');
    expect(url.pathname).toBe('/w/acme/profile');
    expect(url.searchParams.get('tab')).toBe('you');
    expect(url.searchParams.get('meetingIntelligence')).toBe('connected');
  });

  it('carries an error reason', () => {
    const url = resultUrl('https://app.test', '/w/acme/profile', 'error', 'access_denied');
    expect(url.searchParams.get('meetingIntelligenceReason')).toBe('access_denied');
  });

  it('never leaves the origin', () => {
    expect(resultUrl('https://app.test', '//evil.com/x', 'connected').origin).toBe('https://app.test');
  });
});
