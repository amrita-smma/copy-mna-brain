/**
 * Where Google's OAuth and Gmail endpoints live, and the scopes we ask for.
 *
 * `gmail.readonly` — search and read, never modify or delete — is required.
 * `gmail.compose` is what lets a bot save a *draft* for the member to review
 * and send themselves (`send_email` does this instead of mailing). Google's
 * compose scope technically also allows sending, so the code only ever calls
 * `drafts.create`, and a test pins that. Both are *restricted* Google scopes:
 * an OAuth consent screen set to
 * "External" needs Google's verification (and, for it, a security assessment)
 * before anyone outside the test-user list can connect, and while the app is
 * in "Testing" Google expires refresh tokens after 7 days. A consent screen set
 * to "Internal" (a Google Workspace org) needs neither. See
 * docs/features/gmail.md.
 */

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

/** Create drafts in the member's mailbox. Optional on the consent screen: reading works without it. */
export const GMAIL_COMPOSE_SCOPE = 'https://www.googleapis.com/auth/gmail.compose';

/** Everything requested on connect, in consent-screen order. */
export const GMAIL_SCOPES = [GMAIL_SCOPE, GMAIL_COMPOSE_SCOPE] as const;

/** Whether a stored space-separated `scope` string includes `scope`. */
export function hasGmailScope(granted: string | null | undefined, scope: string): boolean {
  return (granted ?? '').split(/\s+/).includes(scope);
}

/** The path, on this app, that Google redirects back to after consent. */
export const GMAIL_CALLBACK_PATH = '/api/integrations/gmail/callback';

export const GOOGLE_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GMAIL_API_URL = 'https://gmail.googleapis.com/gmail/v1';

export interface GmailCredentials {
  clientId: string;
  clientSecret: string;
}

/**
 * This app's Google OAuth client, or null when it isn't set up. It is the same
 * client as Google SSO (`GOOGLE_CLIENT_ID`), plus its secret
 * (`GOOGLE_CLIENT_SECRET`, which sign-in itself doesn't need). Gmail's scope
 * and redirect URI are added to that client, and so to the Google Cloud
 * project's consent screen that SSO shares — see docs/features/gmail.md.
 */
export function gmailCredentials(env: NodeJS.ProcessEnv = process.env): GmailCredentials | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}
