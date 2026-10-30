import { apiRequest } from '@/lib/api/client';
import type { GmailStatus } from '@/lib/services/gmailService';

export interface GmailConnection extends GmailStatus {
  /** The workspace's GMAIL_ENABLED flag. */
  enabled: boolean;
  /** Whether this deployment has a Google OAuth client for Gmail. */
  configured: boolean;
}

const BASE = '/api/integrations/gmail';

/** The signed-in member's connection (the endpoint reads the user from the session). */
export function getGmailConnection(): Promise<GmailConnection> {
  return apiRequest<GmailConnection>(BASE);
}

/** Revoke and forget the member's connection. */
export function disconnectGmail(): Promise<{ connected: false }> {
  return apiRequest<{ connected: false }>(BASE, { method: 'DELETE' });
}

/**
 * Where to navigate the browser to start connecting. It is a full-page
 * redirect chain (our route → Google's consent → our callback), not a fetch;
 * `returnTo` is the in-app path to come back to.
 */
export function gmailConnectUrl(returnTo: string): string {
  return `${BASE}/connect?returnTo=${encodeURIComponent(returnTo)}`;
}
