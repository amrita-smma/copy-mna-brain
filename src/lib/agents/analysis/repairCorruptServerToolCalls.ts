import { AIMessage, BaseMessage } from "@langchain/core/messages";

/**
 * Two ways a persisted assistant turn can hold a `server_tool_use` block the
 * API will not take back:
 *
 * 1. **Blanked input.** Threads checkpointed before the `@langchain/anthropic`
 *    prefilled-input patch (see `tools/server_tools.ts`) hold `server_tool_use`
 *    blocks whose `input` was blanked to `""`/`{}` — the sandbox-issued
 *    `web_search` call arrives complete in `content_block_start` with no
 *    deltas, and the unpatched library discarded it. The fix stopped new
 *    corruption, but the Postgres checkpoints keep the old blocks, so every
 *    later turn on such a thread replays searches as
 *    `{"name":"web_search","input":{}}`. The model reads its own history as
 *    malformed calls ("failed because of invalid input"), imitates the empty
 *    input (a real `invalid_tool_input` error), and routes around web search.
 * 2. **Missing result.** A turn cut off mid-search — the turn budget, Stop, a
 *    platform kill — persists the `server_tool_use` block without the
 *    `*_tool_result` block that would have followed it. The next turn is
 *    rejected outright: `400 invalid_request_error: web_search tool use with
 *    id … was found without a corresponding web_search_tool_result block`.
 *    Unlike a client tool call, a server tool's result cannot be made up, so
 *    the call is stripped instead.
 * 3. **Orphaned result.** A `*_tool_result` block with no `server_tool_use`
 *    before it (`400 invalid_request_error: unexpected tool_use_id found in
 *    web_search_tool_result blocks … must have a corresponding
 *    server_tool_use block before it`). Also stripped.
 *
 * This strips those `server_tool_use` blocks, their paired `*_tool_result`
 * blocks (when present), orphaned `*_tool_result` blocks, and any nested call
 * whose `caller.tool_id` pointed at a stripped block. The surrounding `code_execution` block keeps the code
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
  "[An earlier server tool call was removed from this thread because it was incomplete: its input or its result was not recorded.]";

const isToolResult = (b: Block | undefined): boolean =>
  typeof b?.type === "string" && (b.type as string).endsWith("tool_result");

/**
 * Replacement AIMessages (reusing each message's `id` so the LangGraph
 * messages reducer overwrites in place) with corrupt server-tool blocks
 * removed. Pure: persisting the replacements is the caller's job.
 *
 * Calls and results are paired across a *run* of consecutive assistant
 * messages, not per message: the API merges consecutive same-role turns into
 * one, so a call in one stored message and its result in the next (a turn
 * split around `pause_turn`) is valid, and stripping that call would orphan
 * the result.
 */
export function stripCorruptServerToolCalls(messages: BaseMessage[]): AIMessage[] {
  const replacements: AIMessage[] = [];
  let run: AIMessage[] = [];
  const flush = () => {
    if (run.length > 0) replacements.push(...repairRun(run));
    run = [];
  };
  for (const msg of messages) {
    // Server-tool blocks only appear on assistant turns.
    if (AIMessage.isInstance(msg)) run.push(msg);
    else flush();
  }
  flush();
  return replacements;
}

function repairRun(run: AIMessage[]): AIMessage[] {
  const blocksOf = (m: AIMessage): Block[] => (Array.isArray(m.content) ? (m.content as Block[]) : []);
  const all = run.flatMap(blocksOf);

  // Walk the run in order: a result must come after its call, and a call
  // needs a result somewhere after it.
  const called = new Set<string>();
  const answered = new Set<string>();
  const orphanResults = new Set<Block>();
  for (const b of all) {
    // `mcp_tool_result` pairs with `mcp_tool_use`; count it so it isn't orphaned.
    if ((b?.type === "server_tool_use" || b?.type === "mcp_tool_use") && typeof b.id === "string") {
      called.add(b.id);
    }
    else if (isToolResult(b) && typeof b.tool_use_id === "string") {
      if (called.has(b.tool_use_id)) answered.add(b.tool_use_id);
      else orphanResults.add(b);
    }
  }
  const corruptIds = new Set<string>();
  for (const b of all) {
    if (b?.type !== "server_tool_use" || typeof b.id !== "string") continue;
    if (isEmptyInput(b.input) || !answered.has(b.id)) corruptIds.add(b.id);
  }
  if (corruptIds.size === 0 && orphanResults.size === 0) return [];

  // Cascade: a nested call whose caller was stripped must go too, or the
  // replay carries a `caller.tool_id` pointing at nothing.
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of all) {
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

  const replacements: AIMessage[] = [];
  for (const msg of run) {
    // Skip anything without an id — the reducer matches on id, so a rewrite
    // without one would append a duplicate instead of replacing.
    if (!Array.isArray(msg.content) || !msg.id) continue;
    const blocks = msg.content as Block[];
    const kept = blocks.filter((b) => {
      if (b?.type === "server_tool_use" && corruptIds.has(b.id as string)) return false;
      if (isToolResult(b) && (orphanResults.has(b) || corruptIds.has(b.tool_use_id as string))) return false;
      return true;
    });
    if (kept.length === blocks.length) continue;

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
