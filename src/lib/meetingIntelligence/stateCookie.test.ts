import { describe, expect, it } from 'vitest';
import { STATE_COOKIE_MAX_AGE_SECONDS, STATE_COOKIE_PATH, stateCookieOptions } from './stateCookie';

describe('stateCookieOptions', () => {
  it('is httpOnly, lax, scoped to the integration routes and lives 10 minutes', () => {
    expect(stateCookieOptions(true)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/api/integrations/meeting-intelligence',
      maxAge: 600,
    });
    expect(STATE_COOKIE_PATH).toBe('/api/integrations/meeting-intelligence');
    expect(STATE_COOKIE_MAX_AGE_SECONDS).toBe(600);
  });

  it('drops Secure on plain-http localhost', () => {
    expect(stateCookieOptions(false).secure).toBe(false);
  });
});
