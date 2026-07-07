import { BaseMessage, HumanMessage } from "@langchain/core/messages";

/**
 * Chat attachments are deleted from Anthropic's Files API after each turn, so a
 * `file` content block persisted in the thread history 404s when the next turn
 * replays it. Given the file ids freshly re-uploaded for the current turn
 * (`freshFileIds`), this returns replacement Human messages — reusing each
 * message's existing `id` so the LangGraph messages reducer overwrites it in
 * place — that repoint every stale `file` block at a still-valid id. When
 * nothing is attached anymore (`freshFileIds` empty), the block is swapped for
 * a short text placeholder so the turn still runs.
 *
 * Pure: it only computes replacements; persisting them is the caller's job.
 */
export function rewriteStaleFileBlocks(
  messages: BaseMessage[],
  freshFileIds: string[],
): BaseMessage[] {
  const replacements: BaseMessage[] = [];
  let idx = 0;
  for (const msg of messages) {
    // File blocks only ever appear on user turns. Skip anything without an id —
    // the reducer matches on id, so a rewrite without one would append a
    // duplicate instead of replacing.
    if (msg._getType() !== "human" || !Array.isArray(msg.content) || !msg.id) {
      continue;
    }
    let changed = false;
    const newContent = (msg.content as Array<Record<string, unknown>>).map((block) => {
      if (block && block.type === "file") {
        changed = true;
        if (freshFileIds.length > 0) {
          const fileId = freshFileIds[idx % freshFileIds.length];
          idx += 1;
          return { type: "file", fileId };
        }
        return { type: "text", text: "[attachment removed]" };
      }
      return block;
    });
    if (changed) {
      replacements.push(new HumanMessage({ id: msg.id, content: newContent as never }));
    }
  }
  return replacements;
}
