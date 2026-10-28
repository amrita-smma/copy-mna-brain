/**
 * Server-Sent Events (SSE) encoding helpers, shared by the push streams
 * (`GET /api/events`, `GET /api/bots/events`). Both are Redis pub/sub
 * subscriptions forwarded to the browser; the polling `changeStream` that
 * used to live here (a snapshot re-queried on a timer per connection) is
 * gone — see `docs/features/live-updates-sse.md`.
 */

/** Encode a payload as an SSE `data:` event (with an optional `event:` name). */
export function encodeSseEvent(data: unknown, event?: string): string {
  const lines: string[] = [];
  if (event) lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join('\n')}\n\n`;
}

/** Encode an SSE comment line. Comments are ignored by `EventSource`; used as a keep-alive heartbeat. */
export function encodeSseComment(text: string): string {
  return `: ${text}\n\n`;
}

/** Standard headers for an SSE response. */
export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
} as const;
