import { AIMessage, BaseMessage } from "@langchain/core/messages";

/**
 * Threads checkpointed before the `@langchain/anthropic` prefilled-input patch
 * (see `tools/server_tools.ts`) hold `server_tool_use` blocks whose `input`
 * was blanked to `""`/`{}` — the sandbox-issued `web_search` call arrives
 * complete in `content_block_start` with no deltas, and the unpatched library
 * discarded it. The fix stopped new corruption, but the Postgres checkpoints
 * keep the old blocks, so every later turn on such a thread replays searches
 * as `{"name":"web_search","input":{}}`. The model reads its own history as
 * malformed calls ("failed because of invalid input"), imitates the empty
 * input (a real `invalid_tool_input` error), and routes around web search.
 *
 * This strips the corrupt `server_tool_use` blocks, their paired
 * `*_tool_result` blocks, and any nested call whose `caller.tool_id` pointed
 * at a stripped block. The surrounding `code_execution` block keeps the code
 * that issued the search (which names the query) and its printed results, so
 * little context is lost. Verified against the live API: the stripped history
 * is accepted and the model searches normally again.
 */

type Block = Record<string, unknown>;

const isEmptyInput = (input: unknown): boolean =>
  input === undefined ||
  input === null ||
  input === "" ||
  (typeof input === "object" && !Array.isArray(input) && Object.keys(input as object).length === 0);

/** Placeholder kept when stripping would leave an assistant message empty. */
export const CORRUPT_SERVER_TOOL_PLACEHOLDER =
  "[An earlier server tool call was removed from this thread because its input was not recorded.]";

/**
 * Replacement AIMessages (reusing each message's `id` so the LangGraph
 * messages reducer overwrites in place) with corrupt server-tool blocks
 * removed. Pure: persisting the replacements is the caller's job.
 */
export function stripCorruptServerToolCalls(messages: BaseMessage[]): AIMessage[] {
  const replacements: AIMessage[] = [];
  for (const msg of messages) {
    // Server-tool blocks only appear on assistant turns. Skip anything
    // without an id — the reducer matches on id, so a rewrite without one
    // would append a duplicate instead of replacing.
    if (!AIMessage.isInstance(msg) || !Array.isArray(msg.content) || !msg.id) continue;
    const blocks = msg.content as Block[];

    const corruptIds = new Set<string>();
    for (const b of blocks) {
      if (b?.type === "server_tool_use" && isEmptyInput(b.input) && typeof b.id === "string") {
        corruptIds.add(b.id);
      }
    }
    if (corruptIds.size === 0) continue;

    // Cascade: a nested call whose caller was stripped must go too, or the
    // replay carries a `caller.tool_id` pointing at nothing.
    let grew = true;
    while (grew) {
      grew = false;
      for (const b of blocks) {
        if (
          b?.type === "server_tool_use" &&
          typeof b.id === "string" &&
          !corruptIds.has(b.id) &&
          typeof (b.caller as Block | undefined)?.tool_id === "string" &&
          corruptIds.has((b.caller as Block).tool_id as string)
        ) {
          corruptIds.add(b.id);
          grew = true;
        }
      }
    }

    const kept = blocks.filter((b) => {
      if (b?.type === "server_tool_use" && corruptIds.has(b.id as string)) return false;
      if (
        typeof b?.type === "string" &&
        (b.type as string).endsWith("tool_result") &&
        corruptIds.has(b.tool_use_id as string)
      ) {
        return false;
      }
      return true;
    });

    const content =
      kept.length > 0 ? kept : [{ type: "text", text: CORRUPT_SERVER_TOOL_PLACEHOLDER }];

    replacements.push(
      new AIMessage({
        id: msg.id,
        content: content as never,
        additional_kwargs: msg.additional_kwargs,
        response_metadata: msg.response_metadata,
        ...(msg.tool_calls && msg.tool_calls.length > 0 ? { tool_calls: msg.tool_calls } : {}),
      }),
    );
  }
  return replacements;
}
