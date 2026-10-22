/**
 * Helpers for reading agent output back off a LangChain message list. Pure
 * functions over messages — no model, no graph, no tools.
 */
import { HumanMessage, AIMessage, BaseMessage } from "@langchain/core/messages";

/**
 * Extract the textual content of an agent message.
 *
 * `@langchain/anthropic` returns a tool-using agent's final message `content`
 * as an array of content blocks (e.g. `[{ type: "text", text: "..." }]`),
 * not a plain string. `JSON.stringify`-ing that array escapes newlines and
 * wraps the real text in block metadata, which mangles any embedded JSON and
 * breaks downstream `JSON.parse` extraction. Concatenate the text of every
 * text block instead. Plain-string content (no-tool agents) passes through
 * unchanged.
 */
export function extractMessageText(message: BaseMessage | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (
          block &&
          typeof block === "object" &&
          "text" in block &&
          typeof (block as { text: unknown }).text === "string"
        ) {
          return (block as { text: string }).text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * Pull the strict turn-1 of a thread: the FIRST human message, and the FULL
 * assistant reply to it. A tool-using turn is stored as several messages
 * (AI with tool_calls → Tool result → AI with the final answer), so the
 * assistant text is every `ai` message between the first human and the next
 * human — concatenated — NOT just the first AI blob (which is often only a
 * tool call with little or no text). Later turns are deliberately ignored;
 * they carry context that could mislead a reused answer. Either field is `""`
 * when that message type is absent.
 */
export function extractFirstTurn(messages: BaseMessage[]): {
  userText: string;
  assistantText: string;
} {
  const firstHumanIdx = messages.findIndex((m) => m._getType() === "human");
  if (firstHumanIdx === -1) {
    return { userText: "", assistantText: "" };
  }

  const assistantParts: string[] = [];
  for (let i = firstHumanIdx + 1; i < messages.length; i++) {
    const kind = messages[i]._getType();
    if (kind === "human") break; // next turn starts — stop.
    if (kind !== "ai") continue; // skip tool results etc.
    const text = extractMessageText(messages[i]);
    if (text.trim()) assistantParts.push(text);
  }

  return {
    userText: extractMessageText(messages[firstHumanIdx]),
    assistantText: assistantParts.join("\n\n"),
  };
}

/**
 * Pull the LAST turn of a thread: the most recent human message, and the full
 * assistant reply that followed it. Mirror of {@link extractFirstTurn} — same
 * "every `ai` message until the next human" rule — reading from the end
 * instead of the start.
 *
 * This is what the memory path records: the turn that just finished, not the
 * turn the thread opened on. Either field is `""` when that message type is
 * absent (a thread whose last human message is still being answered yields a
 * `userText` and an empty `assistantText`).
 */
export function extractLastTurn(messages: BaseMessage[]): {
  userText: string;
  assistantText: string;
} {
  let lastHumanIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]._getType() === "human") {
      lastHumanIdx = i;
      break;
    }
  }
  if (lastHumanIdx === -1) return { userText: "", assistantText: "" };

  const assistantParts: string[] = [];
  for (let i = lastHumanIdx + 1; i < messages.length; i++) {
    const kind = messages[i]._getType();
    if (kind === "human") break; // a newer turn started — stop.
    if (kind !== "ai") continue; // skip tool results etc.
    const text = extractMessageText(messages[i]);
    if (text.trim()) assistantParts.push(text);
  }

  return {
    userText: extractMessageText(messages[lastHumanIdx]),
    assistantText: assistantParts.join("\n\n"),
  };
}

export { HumanMessage, AIMessage };

/** The id of the thread's latest user message: tells whether a turn landed. */
export function lastHumanMessageId(messages: BaseMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]._getType() === 'human') return (messages[i] as { id?: string }).id ?? `#${i}`;
  }
  return null;
}
