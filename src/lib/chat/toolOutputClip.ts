/**
 * What the browser keeps of a tool's output.
 *
 * A tool result can be tens of kilobytes (`get_insight` returns a whole
 * document, `query_companies` a page of cards), and every one of them used to
 * ride in the transcript for as long as the tab was open: in each live reply,
 * and again in every history page. The trace shows at most
 * `TOOL_OUTPUT_CLIENT_CHARS` of it, so that is all the client is sent; the
 * rest stays in `copilot_messages` and is fetched when the user asks for it
 * (`GET /api/copilot/chats/:id/tool-outputs/:toolCallId`).
 *
 * The hidden markers a tool appends — approval payloads, citations, files,
 * navigation, company mentions, option cards — are what the cards and
 * handlers read, so they are kept whole whatever the cut.
 *
 * Browser-safe: no imports.
 */

/** How much of a tool's visible output the client holds (and the trace previews). */
export const TOOL_OUTPUT_CLIENT_CHARS = 1200;

/** Set on a tool part's output when the client holds only its head. */
export interface ToolOutputClip {
  /** Length of the visible output (markers excluded) as stored. */
  fullChars: number;
  /** The LangChain tool call id the stored output is found by; absent when unknown. */
  toolCallId?: string;
}

/** The shape a clipped output takes; readers only ever look at `kwargs.content`. */
export interface ClippedToolOutput {
  kwargs: { content: string };
  clipped: ToolOutputClip;
}

/**
 * Every hidden marker the chat writes into a tool output: an HTML comment
 * whose name is upper-case (`CITATIONS_JSON`, `INSIGHT_EDIT_APPROVAL_JSON`,
 * `NAVIGATE_PAGE_JSON`, …) followed by its payload.
 */
const HIDDEN_MARKER_RE = /<!--\s*[A-Z][A-Z0-9_]*:[\s\S]*?-->/g;

/** The output's text, if it has one: a string, or a ToolMessage's `kwargs.content`. */
export function toolOutputContent(output: unknown): string | null {
  if (typeof output === 'string') return output;
  const content = (output as { kwargs?: { content?: unknown } } | null | undefined)?.kwargs?.content;
  return typeof content === 'string' ? content : null;
}

/** The output's clip note, when the client holds only its head. */
export function toolOutputClip(output: unknown): ToolOutputClip | null {
  const clip = (output as { clipped?: unknown } | null | undefined)?.clipped;
  if (!clip || typeof clip !== 'object') return null;
  const { fullChars, toolCallId } = clip as { fullChars?: unknown; toolCallId?: unknown };
  if (typeof fullChars !== 'number') return null;
  return { fullChars, ...(typeof toolCallId === 'string' ? { toolCallId } : {}) };
}

/**
 * `content` cut to its first `max` visible characters, every hidden marker
 * kept after the cut. Unchanged when it fits.
 */
export function clipToolOutputText(
  content: string,
  max: number = TOOL_OUTPUT_CLIENT_CHARS,
): { content: string; fullChars: number; clipped: boolean } {
  const markers: string[] = [];
  const visible = content.replace(HIDDEN_MARKER_RE, (marker) => {
    markers.push(marker);
    return '';
  });
  if (visible.length <= max) return { content, fullChars: visible.length, clipped: false };
  const head = visible.slice(0, max);
  return {
    content: markers.length > 0 ? `${head}\n${markers.join('\n')}` : head,
    fullChars: visible.length,
    clipped: true,
  };
}

/**
 * A tool part's output as the client should hold it: unchanged when its text
 * fits (or it has none), else its head plus a `clipped` note. `toolCallId`
 * names the stored call when the caller knows it; a streamed ToolMessage
 * carries its own.
 */
export function clipToolOutput(
  output: unknown,
  toolCallId?: string,
  max: number = TOOL_OUTPUT_CLIENT_CHARS,
): unknown {
  const content = toolOutputContent(output);
  if (content === null) return output;
  const cut = clipToolOutputText(content, max);
  if (!cut.clipped) return output;
  const id =
    toolCallId ??
    (output as { kwargs?: { tool_call_id?: unknown } }).kwargs?.tool_call_id;
  const clipped: ClippedToolOutput = {
    kwargs: { content: cut.content },
    clipped: { fullChars: cut.fullChars, ...(typeof id === 'string' ? { toolCallId: id } : {}) },
  };
  return clipped;
}

/** A UI message's tool parts clipped (`clipToolOutput`); other parts untouched. */
export function clipToolParts<T extends { type: string }>(parts: readonly T[]): T[] {
  return parts.map((part) => {
    if (part.type !== 'dynamic-tool') return part;
    const p = part as T & { toolCallId?: unknown; output?: unknown };
    if (p.output === undefined) return part;
    const output = clipToolOutput(p.output, typeof p.toolCallId === 'string' ? p.toolCallId : undefined);
    return output === p.output ? part : { ...part, output };
  });
}
