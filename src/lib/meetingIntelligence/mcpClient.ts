import type { MeetingIntelligenceEndpoints } from './config';

/**
 * A minimal MCP (Streamable HTTP) client for the Meeting Intelligence server:
 * JSON-RPC over POST with a bearer token. The server is stateless — plain JSON
 * answers, no `Mcp-Session-Id`, no SSE stream — so there is no session to
 * initialize; an SSE-framed answer is still parsed in case that changes.
 */

/** The tools the server exposes (§6 of its integration guide). */
export const MEETING_INTELLIGENCE_TOOLS = [
  'whoami',
  'list_meetings',
  'search_meetings',
  'get_meeting',
  'list_action_items',
  'get_my_action_items',
  'lookup_my_calendar',
  'lookup_member_calendar',
] as const;
export type MeetingIntelligenceToolName = (typeof MEETING_INTELLIGENCE_TOOLS)[number];

/** 401: the token is missing, expired or revoked, or the member lost access. */
export class McpUnauthorizedError extends Error {
  constructor() {
    super('Meeting Intelligence rejected the access token');
    this.name = 'McpUnauthorizedError';
  }
}

/** Any other non-2xx: 404 = integration off on their side, 429 = rate limited. */
export class McpHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'McpHttpError';
  }
}

/** A JSON-RPC error object (unknown tool, bad arguments, …). */
export class McpRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'McpRpcError';
  }
}

export interface McpToolResult {
  /** The JSON result, when the server sent one. */
  structuredContent: unknown;
  /** The text copy of the result (`content[].text`, joined). */
  text: string;
  /** True when the tool itself reported a failure (bad input, not found). */
  isError: boolean;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

/** The JSON-RPC message in an SSE body: the last `data:` event that parses. */
function parseSse(body: string): JsonRpcResponse | null {
  let found: JsonRpcResponse | null = null;
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    try {
      found = JSON.parse(data) as JsonRpcResponse;
    } catch {
      // Not JSON (keep-alive comment etc.) — skip.
    }
  }
  return found;
}

/** Per-request cap, under the agent tool's own 45 s backstop. */
const MCP_TIMEOUT_MS = 30_000;

let rpcId = 0;

async function rpc(
  endpoints: MeetingIntelligenceEndpoints,
  accessToken: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const res = await fetch(endpoints.mcp, {
    method: 'POST',
    signal: AbortSignal.timeout(MCP_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });

  if (res.status === 401) throw new McpUnauthorizedError();
  if (!res.ok) {
    const retryAfter = Number(res.headers.get('retry-after'));
    const reason =
      res.status === 404
        ? 'the Meeting Intelligence integration is turned off on their side'
        : res.status === 429
          ? 'rate limited by Meeting Intelligence'
          : `Meeting Intelligence answered HTTP ${res.status}`;
    throw new McpHttpError(res.status, reason, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
  }

  const raw = await res.text();
  const contentType = res.headers.get('content-type') ?? '';
  let message: JsonRpcResponse | null;
  if (contentType.includes('text/event-stream')) {
    message = parseSse(raw);
  } else {
    try {
      message = JSON.parse(raw) as JsonRpcResponse;
    } catch {
      message = null;
    }
  }
  if (!message) throw new McpHttpError(res.status, 'Meeting Intelligence sent an unreadable response');
  if (message.error) {
    const code = typeof message.error.code === 'number' ? message.error.code : -32603;
    const text = typeof message.error.message === 'string' ? message.error.message : 'Unknown MCP error';
    throw new McpRpcError(code, text);
  }
  return message.result;
}

/** Call one tool as the member whose access token this is. */
export async function callMcpTool(
  endpoints: MeetingIntelligenceEndpoints,
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const result = (await rpc(endpoints, accessToken, 'tools/call', { name, arguments: args })) as {
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: unknown }>;
    isError?: unknown;
  } | null;
  const text = (result?.content ?? [])
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
  return {
    structuredContent: result?.structuredContent ?? null,
    text,
    isError: result?.isError === true,
  };
}

/** The server's tool catalogue with input schemas (`tools/list`). */
export async function listMcpTools(
  endpoints: MeetingIntelligenceEndpoints,
  accessToken: string,
): Promise<McpToolDefinition[]> {
  const result = (await rpc(endpoints, accessToken, 'tools/list', {})) as { tools?: unknown } | null;
  return Array.isArray(result?.tools) ? (result.tools as McpToolDefinition[]) : [];
}
