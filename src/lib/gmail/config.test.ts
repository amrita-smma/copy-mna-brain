import { describe, expect, it } from 'vitest';
import { GMAIL_COMPOSE_SCOPE, GMAIL_SCOPE, gmailCredentials, hasGmailScope } from './config';

describe('gmailCredentials', () => {
  it('returns the client id and secret when both are set, trimmed', () => {
    expect(gmailCredentials({ GOOGLE_CLIENT_ID: ' id ', GOOGLE_CLIENT_SECRET: ' secret ' } as never)).toEqual({
      clientId: 'id',
      clientSecret: 'secret',
    });
  });

  it('returns null when either is missing or blank, so the integration reads as not set up', () => {
    expect(gmailCredentials({} as never)).toBeNull();
    expect(gmailCredentials({ GOOGLE_CLIENT_ID: 'id' } as never)).toBeNull();
    expect(gmailCredentials({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: '  ' } as never)).toBeNull();
  });

  it('reads the Google SSO client, and ignores the retired GMAIL_CLIENT_* names', () => {
    expect(gmailCredentials({ GMAIL_CLIENT_ID: 'id', GMAIL_CLIENT_SECRET: 's' } as never)).toBeNull();
  });
});

describe('hasGmailScope', () => {
  it('matches a whole scope in the space-separated grant, not a substring', () => {
    const granted = `${GMAIL_SCOPE} openid`;
    expect(hasGmailScope(granted, GMAIL_SCOPE)).toBe(true);
    expect(hasGmailScope(granted, GMAIL_COMPOSE_SCOPE)).toBe(false);
    expect(hasGmailScope(`${GMAIL_SCOPE}.metadata`, GMAIL_SCOPE)).toBe(false);
  });

  it('is false for a missing grant', () => {
    expect(hasGmailScope(null, GMAIL_SCOPE)).toBe(false);
    expect(hasGmailScope('', GMAIL_SCOPE)).toBe(false);
  });
});
