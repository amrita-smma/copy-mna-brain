/**
 * The vocabulary the flavor registry is built from. Type-only apart from the
 * tool arrays it reads shapes off, so every flavor module and the graph builder
 * can import it without pulling in a prompt.
 */
import type {
  tools,
  chatOnlyTools,
  workforceOnlyTools,
  investmentTools,
  vcTools,
  AnthropicServerTool,
} from "../tools";
import type { invenPaidDataSourceSearch } from "../tools/inven_paid_data_source_search";
import type { invenPaidDataSourceEnrichment } from "../tools/inven_paid_data_source_enrichment";
import type { financialEquityAnalysis } from "../tools/financial_equity_analysis";

// The user-selectable Copilot flavors. Persisted per-workspace on
// `workspaces.copilot_agent` and resolved by the chat route. The union is
// derived from COPILOT_AGENT_KEYS so the key list has exactly one home.
import type { CopilotAgentType } from "./keys";
import type { ToolListFactory } from "./lazyToolList";
export type { CopilotAgentType };

// Permissive union element type so a single function signature accepts
// any of these arrays. Each contains langchain tool() results or Anthropic
// server-tool definitions — the structural shape is the same, only the
// specific subset differs.
export type ToolList = Array<
  | (typeof tools)[number]
  | (typeof chatOnlyTools)[number]
  | (typeof workforceOnlyTools)[number]
  | (typeof investmentTools)[number]
  | (typeof vcTools)[number]
  // Registered by no general flavour; the premium-data grant to @minerba and
  // @dikti composes them into sector tool sets.
  | typeof invenPaidDataSourceSearch
  | typeof invenPaidDataSourceEnrichment
  // In no array above: @minority adds it to the M&A chat list and the
  // workforce list appends it, rather than it belonging to one shared base.
  | typeof financialEquityAnalysis
  | AnthropicServerTool
>;

/**
 * One Copilot flavor: the tool set it reads the world with and the system
 * prompt that tells it what its job is. Adding a flavor is a new file in this
 * folder exporting one of these, plus its key in `./keys` and its line in
 * `./index.ts` — nothing in the graph builder changes.
 */
export interface CopilotFlavor {
  /** The value stored on `workspaces.copilot_agent`. */
  key: CopilotAgentType;
  /**
   * Built on first call, not at module-evaluation time — see
   * `./lazyToolList` for the import cycle that makes this mandatory.
   */
  toolList: ToolListFactory;
  systemPrompt: string;
}
