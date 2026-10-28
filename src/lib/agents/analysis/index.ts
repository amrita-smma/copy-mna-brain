/**
 * The analysis agent's public surface. Everything in this folder is reachable
 * through this barrel, so a consumer importing `@/lib/agents/analysis` never
 * needs to know which module something lives in.
 *
 * The folder, in dependency order (each layer may import the ones above it,
 * never the ones below):
 *
 *   effort.ts      reasoning-effort tiers — the model and `output_config.effort`
 *   guides.ts      prompt fragments every chat flavor appends
 *   flavors/       one file per Copilot flavor + the registry that lists them
 *   workforce.ts   the Workforce agent's tools, HITL middleware and prompt
 *   runtime.ts     how an agent is built and driven (createLocalAgent, AgentGraph)
 *   graphs.ts      the memoized graphs and the getters routes call
 *   messages.ts    reading agent output back off a message list
 *
 * To add a Copilot flavor, see the instructions at the top of `flavors/index.ts`.
 */

// --- Reasoning effort -------------------------------------------------------
export type { EffortChoice, ManualEffortChoice, OutputEffort, EffortTier } from "./effort";
export {
  maxEffort,
  asEffortChoice,
  asManualEffort,
  EFFORT_TIERS,
  CHAT_TURN_BUDGET_CEILING_MS,
} from "./effort";

// --- Flavors ----------------------------------------------------------------
export type { CopilotAgentType, CopilotFlavor, ToolList } from "./flavors/types";
export { COPILOT_FLAVORS, DEFAULT_COPILOT_AGENT, getCopilotFlavor } from "./flavors";

// --- Shared chat prompt fragments -------------------------------------------
export {
  CONSOLE_NAVIGATION_GUIDE,
  INSIGHT_AUTHORING_GUIDE,
  INSIGHT_TEMPLATE_AUTHORING_GUIDE,
  NEXT_ACTION_GUIDE,
} from "./guides";

// --- Workforce --------------------------------------------------------------
// The guides are re-exported for the sector agents, which assemble their own
// workforce prompt from the same fragments (src/lib/agents/sector/rolePrompt.ts).
export {
  WORKFORCE_HITL_MIDDLEWARE,
  WORKFORCE_QUESTION_TOOL_GUIDE,
  WORKFORCE_TRACE_TOOLS_GUIDE,
  WORKFORCE_EVIDENCE_GUIDE,
  WORKFORCE_EXECUTION_GUIDE,
  WORKFORCE_REPORTING_FORMAT,
  WORKFORCE_CONSTRAINTS,
  WORKFORCE_INSIGHT_AUTHORING_GUIDE,
} from "./workforce";

// --- Runtime ----------------------------------------------------------------
export type {
  AgentConfig,
  InvokeOptions,
  InvokeConfig,
  InvokeResult,
  ThreadSnapshot,
} from "./runtime";
export {
  AgentGraph,
  createLocalAgent,
  withoutTools,
  isPauseTurn,
  PAUSE_TURN_WARNING,
} from "./runtime";

// --- Checkpoint write stats -------------------------------------------------
export { beginCheckpointStats, type CheckpointWriteStats } from "./checkpointStats";

// --- Graphs -----------------------------------------------------------------
export {
  buildAgentGraph,
  getAgentGraph,
  getAgentGraphForModel,
  getStatelessAgentGraph,
  getWorkforceAgentGraphForEffort,
  getWorkforceAgentGraph,
  onResetAgent,
  readThreadSnapshot,
  resetAgent,
} from "./graphs";

// --- Messages ---------------------------------------------------------------
export {
  extractMessageText,
  extractFirstTurn,
  extractLastTurn,
  lastHumanMessageId,
  HumanMessage,
  AIMessage,
} from "./messages";
