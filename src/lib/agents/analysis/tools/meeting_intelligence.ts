import { tool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createDb } from '@/lib/server/db';
import { meetingIntelligenceEnabled } from '@/lib/flags';
import { NO_USER_CONTEXT_ERROR, readBotToolContext } from '@/lib/bots/toolContext';
import {
  MEETING_INTELLIGENCE_TOOLS,
  McpHttpError,
  McpRpcError,
  type McpToolResult,
} from '@/lib/meetingIntelligence';
import {
  MeetingIntelligenceNotConnectedError,
  MeetingIntelligenceRefreshPendingError,
} from '@/lib/services/meetingIntelligenceService';
import { withToolTimeout } from '../../withToolTimeout';
import { logger } from '../../logger';

/** Backstop so a hung Meeting Intelligence call can't hold the turn open. */
export const MEETING_INTELLIGENCE_TOOL_TIMEOUT_MS = 45_000;

/** Cap on the result handed back to the model — a month of recaps can be large. */
export const MEETING_INTELLIGENCE_MAX_RESULT_CHARS = 40_000;

export const meetingIntelligenceSchema = z.object({
  tool: z
    .enum(MEETING_INTELLIGENCE_TOOLS)
    .describe(
      'Which Meeting Intelligence tool to run: whoami, list_meetings, search_meetings, get_meeting, list_action_items, get_my_action_items, lookup_my_calendar, lookup_member_calendar.',
    ),
  arguments: z
    .record(z.unknown())
    .optional()
    .describe(
      "That tool's arguments, as an object. Dates are YYYY-MM-DD; task status is one of completed, on_track, delayed, at_risk. Omit for tools that need none (whoami). If an argument name is wrong the result includes the tool's input schema — retry with it.",
    ),
});

export type MeetingIntelligenceInput = z.infer<typeof meetingIntelligenceSchema>;

export const NOT_ENABLED_MESSAGE =
  'Meeting Intelligence is not enabled for this workspace. A superadmin can turn it on in the Admin Portal → Features ("Meeting Intelligence"). Answer from other sources, e.g. query_files for meeting notes uploaded here.';

export function notConnectedMessage(reason: 'not_connected' | 'expired'): string {
  const why =
    reason === 'expired'
      ? "The user's Meeting Intelligence connection has expired or was revoked."
      : "The user hasn't connected their Meeting Intelligence account yet.";
  return `${why} Ask them to click "Connect Apps" at the bottom of the sidebar (Profile → Connected apps) and press Connect on MoM Intelligent, then ask again. Do not retry this tool until they have.`;
}

function formatResult(name: string, result: McpToolResult): string {
  const body =
    result.structuredContent !== null && result.structuredContent !== undefined
      ? JSON.stringify(result.structuredContent, null, 2)
      : result.text || '(empty result)';
  const truncated =
    body.length > MEETING_INTELLIGENCE_MAX_RESULT_CHARS
      ? `${body.slice(0, MEETING_INTELLIGENCE_MAX_RESULT_CHARS)}\n… [truncated — narrow the date range or filters for the rest]`
      : body;
  return `**Meeting Intelligence — ${name}:**\n\n${truncated}\n\n---\n*Source: Meeting Intelligence (MoM AI Intelligent), as seen by the connected user.*`;
}

async function runMeetingIntelligence(
  input: MeetingIntelligenceInput,
  config?: RunnableConfig,
): Promise<string> {
  const name = input.tool;
  const args = input.arguments ?? {};
  logger.debug(`🔧 TOOL CALLED: meeting_intelligence(tool='${name}')`);

  const ctx = readBotToolContext(config);
  if (!ctx) return NO_USER_CONTEXT_ERROR;
  if (!(await meetingIntelligenceEnabled())) return NOT_ENABLED_MESSAGE;

  const { createContainer } = await import('@/lib/services/container');
  const { meetingIntelligenceService } = createContainer(createDb(), await getActiveWorkspaceId());

  // The input schema, appended when the model got an argument wrong.
  const schemaHint = async (): Promise<string> => {
    try {
      const def = await meetingIntelligenceService.describeTool(ctx.userId, name);
      return def?.inputSchema ? `\n\nInput schema for ${name}:\n${JSON.stringify(def.inputSchema)}` : '';
    } catch {
      return '';
    }
  };

  try {
    const result = await meetingIntelligenceService.callTool(ctx.userId, name, args);
    if (result.isError) {
      return `**Meeting Intelligence ${name} failed:** ${result.text || 'the tool reported an error'}${await schemaHint()}`;
    }
    return formatResult(name, result);
  } catch (error) {
    if (error instanceof MeetingIntelligenceNotConnectedError) {
      return notConnectedMessage(error.reason);
    }
    if (error instanceof MeetingIntelligenceRefreshPendingError) {
      return 'Meeting Intelligence is renewing its access for this user right now. Call the tool again once.';
    }
    if (error instanceof McpRpcError) {
      return `**Meeting Intelligence ${name} failed:** ${error.message}${await schemaHint()}`;
    }
    if (error instanceof McpHttpError) {
      if (error.status === 429) {
        const wait = error.retryAfterSeconds ? ` Try again in ${error.retryAfterSeconds}s.` : '';
        return `Meeting Intelligence is rate limiting requests.${wait}`;
      }
      return `Meeting Intelligence is unavailable: ${error.message}.`;
    }
    logger.error(`meeting_intelligence error: ${(error as Error).message}`);
    return `**Error:** Meeting Intelligence request failed: ${(error as Error).message}`;
  }
}

/**
 * Read the chatting user's meetings from Meeting Intelligence (MoM AI
 * Intelligent) through its MCP server — recaps, action items and calendars —
 * acting as that user, so it sees only what they can see there. Read-only.
 *
 * Gated twice: the workspace's MEETING_INTELLIGENCE_ENABLED flag, and the
 * user's own connection (Connect Apps → Profile → Connected apps → Connect). Both failures come
 * back as instructions for the model to relay, never as a thrown error.
 */
export const meetingIntelligence = tool(
  withToolTimeout('meeting_intelligence', MEETING_INTELLIGENCE_TOOL_TIMEOUT_MS, runMeetingIntelligence),
  {
    name: 'meeting_intelligence',
    description: `Read the user's meetings from Meeting Intelligence (MoM AI Intelligent): meeting recaps, decisions, action items / tasks and calendars. Runs as the chatting user and sees only what they can see there. Read-only.

Tools:
- whoami — the connected user: name, email, role, name aliases (use the aliases to match "my" tasks)
- list_meetings — meetings in a date range (default: last 30 days)
- search_meetings — keyword search across meeting recaps
- get_meeting — the full recap of one meeting, by meetingId or date
- list_action_items — tasks filtered by status, owner or date; per-owner counts with group_by: "owner"
- get_my_action_items — the user's own tasks (e.g. { "status": "delayed" })
- lookup_my_calendar — the user's calendar for a day
- lookup_member_calendar — a teammate's calendar, only if they share it

Use it for questions about what was discussed or decided in meetings, who owns which follow-up, overdue / delayed / at-risk tasks, and someone's schedule. Search or list first, then get_meeting for detail. Prefer it over query_files for meeting recaps; query_files covers documents uploaded to this workspace instead.`,
    schema: meetingIntelligenceSchema,
  },
);
