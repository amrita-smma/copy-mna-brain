/**
 * The `deal_type` a Copilot flavor stamps on a company it creates when the
 * instruction does not name one.
 *
 * A flavor already decides what the agent reads and what its job is; this says
 * what KIND of transaction it is looking at, so a workspace running the
 * capital-markets Copilot does not accumulate a pipeline of deals labelled
 * "majority" simply because that is the column default. `add_company` resolves
 * it from `workspaces.copilot_agent`; an explicit `deal_type` argument always
 * wins.
 *
 * `promote_to_l0` deliberately does NOT apply it: the L0 gate asks for the
 * deal's shape precisely so somebody states it, and a silent default there
 * would answer the question the gate is posing.
 *
 * Deliberately a standalone module rather than a field on `CopilotFlavor`:
 * importing `./index` from a tool would close the
 * `tools/index → add_company → flavors/index → mna → tools/index` cycle that
 * `./lazyToolList` exists to keep open. This file imports only `./keys` and the
 * dependency-free deal-type vocabulary, so a tool can import it directly.
 */
import type { DealType } from "@/lib/companies/dealTypes";
import { DEFAULT_COPILOT_AGENT, type CopilotAgentType } from "./keys";

/**
 * Keyed by `CopilotAgentType`, so adding a flavor to `COPILOT_AGENT_KEYS`
 * fails the build until it declares a default — the same guarantee
 * `COPILOT_FLAVORS` gives.
 */
export const FLAVOR_DEFAULT_DEAL_TYPE: Record<CopilotAgentType, DealType> = {
  // Principal side, control: the M&A desk buys companies outright.
  mna: "majority",
  // Listed minority stakes — the flavor's whole subject is the public book.
  minority: "public_market",
  // The capital-markets desk's bread and butter is taking issuers public.
  capital_markets: "ipo",
  // The advisory desk's structuring default; the other routes it compares
  // (sale, bond issuance, recap) are named explicitly when it means them.
  investment_banking: "joint_venture",
  crowdfunding: "equity_crowdfunding",
  // Venture and the combined desk take non-control positions by default.
  vc: "minority",
  combined: "minority",
  // The funds/investing flavor carries no pipeline tools and never creates a
  // company, so this value is unreachable — it exists to keep the Record
  // exhaustive.
  investment: "majority",
};

/**
 * The default for a flavor key, falling back to the `mna` default for a key
 * this build doesn't know. `workspaces.copilot_agent` is a plain text column,
 * so a row written by a newer deploy must not break company creation.
 */
export function defaultDealTypeFor(agentType: CopilotAgentType): DealType {
  return (
    FLAVOR_DEFAULT_DEAL_TYPE[agentType] ??
    FLAVOR_DEFAULT_DEAL_TYPE[DEFAULT_COPILOT_AGENT]
  );
}
