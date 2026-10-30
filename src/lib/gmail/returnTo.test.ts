import { describe, expect, it } from 'vitest';
import { DEFAULT_RETURN_PATH, RESULT_PARAM, resultUrl } from './returnTo';

describe('resultUrl', () => {
  it('appends the outcome to the return path on the same origin', () => {
    expect(resultUrl('https://app.test', '/w/acme/profile?tab=apps', 'connected').toString()).toBe(
      `https://app.test/w/acme/profile?tab=apps&${RESULT_PARAM}=connected`,
    );
  });

  it('adds a clipped reason for an error', () => {
    const url = resultUrl('https://app.test', '/w/acme/profile', 'error', 'x'.repeat(500));
    expect(url.searchParams.get('gmail')).toBe('error');
    expect(url.searchParams.get('gmailReason')).toHaveLength(200);
  });

  it('never redirects off-origin: a hostile returnTo falls back to the default path', () => {
    for (const bad of ['//evil.com', 'https://evil.com/x', '/\\evil.com']) {
      const url = resultUrl('https://app.test', bad, 'connected');
      expect(url.origin).toBe('https://app.test');
      expect(url.pathname).toBe(DEFAULT_RETURN_PATH);
    }
  });
});
