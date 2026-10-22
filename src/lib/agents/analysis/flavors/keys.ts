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
  "investment_banking",
  "capital_markets",
] as const;

export type CopilotAgentType = (typeof COPILOT_AGENT_KEYS)[number];

/** The default when a stored value names no flavor this build knows. */
export const DEFAULT_COPILOT_AGENT: CopilotAgentType = "mna";

/** Narrow an untrusted value (a DB column, a PATCH payload) to a flavor key. */
export function isCopilotAgentType(value: unknown): value is CopilotAgentType {
  return typeof value === "string" && (COPILOT_AGENT_KEYS as readonly string[]).includes(value);
}

/**
 * Display names for each flavor, for pickers (the admin portal's workspace
 * Copilot setting and the bot editor's base flavor). A `Record` keyed by
 * `CopilotAgentType`, so a new key fails the build until it has a label.
 */
export const COPILOT_AGENT_LABELS: Record<CopilotAgentType, string> = {
  mna: "M&A / Acquisitions",
  investment: "Funds & Investing",
  combined: "Combined (M&A + Investment)",
  vc: "VC / Growth Equity",
  minority: "Minority Stakes Portfolio Manager",
  crowdfunding: "Crowdfunding Agent",
  investment_banking: "Investment Banking Advisory",
  capital_markets: "Capital Markets (DCM / ECM)",
};
