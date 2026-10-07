/**
 * The Copilot flavor registry. One entry per selectable flavor, keyed by the
 * value stored on `workspaces.copilot_agent`.
 *
 * ## Adding a flavor
 *
 * 1. Add its key to `COPILOT_AGENT_KEYS` in `./keys`. The build now fails
 *    until steps 2 and 3 are done, and `workspaceService` accepts the new key
 *    without being touched.
 * 2. Create `./<key>.ts` exporting a `CopilotFlavor` (its tool list and its
 *    system prompt).
 * 3. Add it to `COPILOT_FLAVORS` below.
 *
 * Then wire the two user-facing places that name a flavor: the admin-portal
 * picker, and the chat welcome message + suggestions. Nothing in the graph
 * builder changes — `getAgentGraph` resolves through this map.
 *
 * `promptStability.test.ts` pins every assembled prompt's hash, so a flavor
 * that moves files without meaning to change wording fails loudly.
 */
import { CAPITAL_MARKETS_FLAVOR } from "./capital_markets";
import { COMBINED_FLAVOR } from "./combined";
import { CROWDFUNDING_FLAVOR } from "./crowdfunding";
import { INVESTMENT_FLAVOR } from "./investment";
import { INVESTMENT_BANKING_FLAVOR } from "./investment_banking";
import { MINORITY_FLAVOR } from "./minority";
import { MNA_FLAVOR } from "./mna";
import { VC_FLAVOR } from "./vc";
import { DEFAULT_COPILOT_AGENT } from "./keys";
import type { CopilotAgentType, CopilotFlavor } from "./types";

export type { CopilotAgentType, CopilotFlavor, ToolList } from "./types";
export { COPILOT_AGENT_KEYS, DEFAULT_COPILOT_AGENT, isCopilotAgentType } from "./keys";

export const COPILOT_FLAVORS: Record<CopilotAgentType, CopilotFlavor> = {
  mna: MNA_FLAVOR,
  investment: INVESTMENT_FLAVOR,
  combined: COMBINED_FLAVOR,
  vc: VC_FLAVOR,
  minority: MINORITY_FLAVOR,
  crowdfunding: CROWDFUNDING_FLAVOR,
  investment_banking: INVESTMENT_BANKING_FLAVOR,
  capital_markets: CAPITAL_MARKETS_FLAVOR,
};

/**
 * Resolve a flavor, falling back to `mna` for a key this build doesn't know —
 * `workspaces.copilot_agent` is a plain text column, so a row written by a
 * newer deploy (or by hand) must not take the chat down.
 */
export function getCopilotFlavor(agentType: CopilotAgentType): CopilotFlavor {
  return COPILOT_FLAVORS[agentType] ?? COPILOT_FLAVORS[DEFAULT_COPILOT_AGENT];
}

/** What `createLocalAgent` falls back to when a caller passes neither. */
export { defaultChatToolList, CHAT_SYSTEM_PROMPT } from "./mna";
export { lazyToolList, type ToolListFactory } from "./lazyToolList";
