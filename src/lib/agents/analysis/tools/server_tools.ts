/**
 * Anthropic-hosted tools executed directly on Anthropic's infrastructure.
 *
 * Depend on local patch `patches/@langchain__anthropic@1.3.26.patch`.
 * Inbound (`dist/utils/message_outputs.js`) and outbound (`dist/utils/message_inputs.js`)
 * allowlists must agree to prevent orphaned tool uses from poisoning threads.
 *
 * Do not drop the patch until upstream includes all four *_tool_result types in both lists:
 * `web_fetch_tool_result`, `code_execution_tool_result`, `bash_code_execution_tool_result`,
 * and `text_editor_code_execution_tool_result`.
 *
 * Never declare `code_execution` explicitly (run internally by 2026 variants).
 * max_uses is capped at 5 per turn to prevent runaway token costs.
 */
export interface AnthropicServerTool {
  type: string;
  name: string;
  max_uses?: number;
}

export const SERVER_TOOLS: AnthropicServerTool[] = [
  { type: "web_search_20260209", name: "web_search", max_uses: 5 },
  { type: "web_fetch_20260209", name: "web_fetch", max_uses: 5 },
];
