/**
 * The flavor keys, and nothing else.
 *
 * `CopilotAgentType` is derived from the array, so this list is the ONE place a
 * flavor key is written down: `COPILOT_FLAVORS` in `./index.ts` is a
 * `Record<CopilotAgentType, …>`, so adding a key here fails the build until the
 * flavor exists.
 *
 * Deliberately dependency-free — it imports nothing, and `keys.test.ts`
 * enforces that. `workspaceService.ts` validates `workspaces.copilot_agent`
 * against this list, and it must not drag the LangChain agent stack into a
 * service, a route or the client bundle to do it.
 */

/** The user-selectable Copilot flavors, persisted on `workspaces.copilot_agent`. */
export const COPILOT_AGENT_KEYS = [
  "mna",
  "investment",
  "combined",
  "vc",
  "minority",
  "crowdfunding",
] as const;

export type CopilotAgentType = (typeof COPILOT_AGENT_KEYS)[number];

/** The default when a stored value names no flavor this build knows. */
export const DEFAULT_COPILOT_AGENT: CopilotAgentType = "mna";

/** Narrow an untrusted value (a DB column, a PATCH payload) to a flavor key. */
export function isCopilotAgentType(value: unknown): value is CopilotAgentType {
  return typeof value === "string" && (COPILOT_AGENT_KEYS as readonly string[]).includes(value);
}
