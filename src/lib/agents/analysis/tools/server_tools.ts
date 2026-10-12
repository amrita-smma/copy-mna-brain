/**
 * Anthropic-hosted tools executed directly on Anthropic's infrastructure.
 *
 * Depend on local patch `patches/@langchain__anthropic@1.3.26.patch`, which
 * fixes two separate defects in how `@langchain/anthropic` parses a server-tool
 * stream. Both are asserted behaviourally in `server_tools.test.ts`; neither is
 * fixed upstream as of 1.5.12, so an upgrade does not retire the patch.
 *
 * 1. Result-type allowlists. Inbound (`dist/utils/message_outputs.js`) and
 *    outbound (`dist/utils/message_inputs.js`) must agree, or an orphaned tool
 *    use poisons the thread. Do not drop the patch until upstream includes all
 *    four *_tool_result types in both lists: `web_fetch_tool_result`,
 *    `code_execution_tool_result`, `bash_code_execution_tool_result`, and
 *    `text_editor_code_execution_tool_result`.
 *
 * 2. Prefilled tool input. Stock blanks `input` to "" on every
 *    `server_tool_use` content_block_start, assuming `input_json_delta` events
 *    refill it. True for `code_execution` (the model writes the code token by
 *    token); false for the nested `web_search` call the sandbox makes, which
 *    arrives COMPLETE in content_block_start with no deltas following. Blanked,
 *    the query is gone, and every later turn replays the search as
 *    `{"name":"web_search","input":{}}` — the agent reads its own history as a
 *    malformed call and concludes web search is unavailable.
 *
 * Never declare `code_execution` explicitly (run internally by 2026 variants).
 *
 * ## `max_uses` must not bind during ordinary research
 *
 * `max_uses` caps the searches performed within ONE Messages API request, and
 * that single request is the whole server-side loop — on `_20260209` web search
 * runs from inside code execution (`allowed_callers` defaults to
 * `["code_execution_20260120"]`), so one filtering pass can fire several
 * searches before the request ever returns. Anthropic's own sizing: simple
 * factual queries use 1-3 searches, "comparative or multientity research can
 * use 10 or more".
 *
 * Research here is always the multientity kind. `guides.ts` tells the agent to
 * "reach for `web_search` freely, and more than once in a turn when you need
 * several angles (the company, its market, its comparables)", and
 * `workforce.ts` makes one call the floor rather than the ceiling. A cap of 5
 * was set when external search was an occasional step; against those prompts a
 * single request blows through it. Every further search then returns a
 * `max_uses_exceeded` error — a 200, not an exception — and the agent quietly
 * degrades to `valyu_search`, whose results carry no citation payload, so the
 * answer loses its `cite` tags too.
 *
 * Keep this ceiling clear of what one research request actually spends. The
 * real guardrail against a runaway turn is `turnBudgetMs` in `../effort.ts`,
 * which aborts on wall clock, plus the graph recursion limit.
 */
export interface AnthropicServerTool {
  type: string;
  name: string;
  max_uses?: number;
}

/**
 * Lower bound enforced by `server_tools.test.ts`. Not a tuning knob — it is the
 * line below which the cap starts binding on normal research threads.
 */
export const MIN_SERVER_TOOL_MAX_USES = 25;

export const SERVER_TOOLS: AnthropicServerTool[] = [
  { type: "web_search_20260209", name: "web_search", max_uses: 30 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 30 },
];
