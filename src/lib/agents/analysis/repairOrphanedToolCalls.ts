import {
  AIMessage,
  BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";

/**
 * Content written for tool_calls that never received a ToolMessage — typically
 * because the client aborted mid-tool (chat switch / Stop) during a long run
 * like PPTX generation. Anthropic rejects the next turn until every tool_use
 * has a matching tool_result.
 */
export const ORPHANED_TOOL_CANCELLED_CONTENT =
  "**Cancelled:** The previous tool call was interrupted before it finished " +
  "(for example you switched chats or stopped generation). " +
  "Ask again if you still need it.";

export type OrphanedToolCall = { id: string; name?: string };

/** Find AIMessage tool_calls that have no matching ToolMessage yet. */
export function collectOrphanedToolCalls(
  messages: BaseMessage[],
): OrphanedToolCall[] {
  const answered = new Set<string>();
  for (const msg of messages) {
    if (!ToolMessage.isInstance(msg)) continue;
    const id = (msg as ToolMessage).tool_call_id;
    if (id) answered.add(id);
  }

  const orphans: OrphanedToolCall[] = [];
  const seen = new Set<string>();
  for (const msg of messages) {
    if (!AIMessage.isInstance(msg)) continue;
    const calls = (msg as AIMessage).tool_calls ?? [];
    for (const tc of calls) {
      const id = tc?.id;
      if (!id || answered.has(id) || seen.has(id)) continue;
      seen.add(id);
      orphans.push({
        id,
        name: typeof tc.name === "string" ? tc.name : undefined,
      });
    }
  }
  return orphans;
}

/** Synthetic ToolMessages that close orphaned tool_calls so the thread can continue. */
export function buildOrphanedToolRepairMessages(
  messages: BaseMessage[],
): ToolMessage[] {
  return collectOrphanedToolCalls(messages).map(
    ({ id, name }) =>
      new ToolMessage({
        content: ORPHANED_TOOL_CANCELLED_CONTENT,
        tool_call_id: id,
        ...(name ? { name } : {}),
      }),
  );
}
