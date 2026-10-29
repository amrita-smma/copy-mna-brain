import { apiRequest } from '@/lib/api/client';
import type { MeetingIntelligenceStatus } from '@/lib/services/meetingIntelligenceService';

export interface MeetingIntelligenceConnection extends MeetingIntelligenceStatus {
  /** The workspace's MEETING_INTELLIGENCE_ENABLED flag. */
  enabled: boolean;
}

const BASE = '/api/integrations/meeting-intelligence';

/** The signed-in member's connection (the endpoint reads the user from the session). */
export function getMeetingIntelligenceConnection(): Promise<MeetingIntelligenceConnection> {
  return apiRequest<MeetingIntelligenceConnection>(BASE);
}

/** Revoke and forget the member's connection. */
export function disconnectMeetingIntelligence(): Promise<{ connected: false }> {
  return apiRequest<{ connected: false }>(BASE, { method: 'DELETE' });
}

/**
 * Where to navigate the browser to start connecting. It is a full-page
 * redirect chain (our route → their sign-in → our callback), not a fetch;
 * `returnTo` is the in-app path to come back to.
 */
export function meetingIntelligenceConnectUrl(returnTo: string): string {
  return `${BASE}/connect?returnTo=${encodeURIComponent(returnTo)}`;
}
