/**
 * Where the Meeting Intelligence (MoM AI Intelligent) server lives, and the
 * fixed OAuth values its MCP endpoint expects. Override the server with
 * `MEETING_INTELLIGENCE_BASE_URL` (e.g. a staging instance); everything else is
 * derived from it, and must match exactly — the server rejects a different
 * `resource` (`invalid_target`) or `scope` (`invalid_scope`).
 */

export const DEFAULT_MEETING_INTELLIGENCE_BASE_URL = 'https://meeting-intelligence.starcapital.co.id';

/** The only scope the server grants. Read-only. */
export const MEETING_INTELLIGENCE_SCOPE = 'mcp:read';

/** Shown to members on the server's consent page and Connected apps list. */
export const MEETING_INTELLIGENCE_CLIENT_NAME = 'MnA Brain Copilot';

/** The path, on this app, that the server redirects back to after consent. */
export const MEETING_INTELLIGENCE_CALLBACK_PATH = '/api/integrations/meeting-intelligence/callback';

export interface MeetingIntelligenceEndpoints {
  /** Base URL with no trailing slash — also the key stored on clients/connections. */
  serverUrl: string;
  mcp: string;
  register: string;
  authorize: string;
  token: string;
  revoke: string;
}

export function meetingIntelligenceEndpoints(
  baseUrl: string = process.env.MEETING_INTELLIGENCE_BASE_URL || DEFAULT_MEETING_INTELLIGENCE_BASE_URL,
): MeetingIntelligenceEndpoints {
  const serverUrl = baseUrl.replace(/\/+$/, '');
  return {
    serverUrl,
    mcp: `${serverUrl}/api/mcp`,
    register: `${serverUrl}/api/oauth/register`,
    authorize: `${serverUrl}/api/oauth/authorize`,
    token: `${serverUrl}/api/oauth/token`,
    revoke: `${serverUrl}/api/oauth/revoke`,
  };
}
