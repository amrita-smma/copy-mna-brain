import { describe, expect, it, vi } from "vitest";

// `tools/index` reaches the agent module through the workforce trigger, which
// imports back into `tools` — stubbing the agent breaks that cycle so the tool
// arrays are populated rather than undefined at import time.
vi.mock("@/lib/agents/analysis", () => ({
  getStatelessAgentGraph: vi.fn(),
  getWorkforceAgentGraphForEffort: vi.fn(),
  getAgentGraph: vi.fn(),
  createLocalAgent: vi.fn(),
  AgentGraph: vi.fn(),
}));

import {
  tools,
  chatOnlyTools,
  workforceOnlyTools,
  investmentTools,
  combinedTools,
  vcTools,
  valyuSearch,
  getToolDescriptions,
} from "./index";

/** The tool set each agent flavor is actually constructed with. */
const AGENT_TOOL_LISTS = {
  workforce: [...tools, ...workforceOnlyTools],
  chat: [...tools, ...chatOnlyTools, valyuSearch],
  investment: investmentTools,
  combined: combinedTools,
  vc: vcTools,
};

describe("agent tool lists", () => {
  // The AI Opinion workforce run has to read the firm's mandate before it votes
  // pass/fail, and the workforce list is `tools` + workforce-only writes — so
  // the thesis reader has to live in the shared read base, not only in the VC
  // flavor's curated list.
  it("exposes get_investment_theses to the workforce agent", () => {
    expect(AGENT_TOOL_LISTS.workforce.map((t) => t.name)).toContain(
      "get_investment_theses",
    );
  });

  it("exposes get_investment_theses to the M&A chat agent", () => {
    expect(AGENT_TOOL_LISTS.chat.map((t) => t.name)).toContain("get_investment_theses");
  });

  // Field-level company edits are a write, so they belong to the workforce
  // only: chat proposes them via propose_workforce_handoff and the user
  // approves the card before anything is mutated.
  it("exposes update_company_details to the workforce agent", () => {
    expect(AGENT_TOOL_LISTS.workforce.map((t) => t.name)).toContain(
      "update_company_details",
    );
  });

  it.each([
    ["chat", AGENT_TOOL_LISTS.chat],
    ["combined", AGENT_TOOL_LISTS.combined],
    ["vc", AGENT_TOOL_LISTS.vc],
  ])("keeps update_company_details out of the %s agent", (_label, list) => {
    expect(list.map((t) => t.name)).not.toContain("update_company_details");
  });

  // AlphaSense is the firm's premium research subscription — every flavor,
  // including the workforce, is meant to be able to reach it.
  it.each(Object.entries(AGENT_TOOL_LISTS))(
    "exposes alphasense_search to the %s agent",
    (_label, list) => {
      expect(list.map((t) => t.name)).toContain("alphasense_search");
    },
  );

  it.each(Object.entries(AGENT_TOOL_LISTS))(
    "registers each tool name exactly once in the %s list",
    (_label, list) => {
      // A duplicate name is not a no-op: createAgent rejects two tools sharing
      // one name, so this guards every list that spreads `tools`.
      const names = list.map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
    },
  );
});

describe("getToolDescriptions", () => {
  it("describes the theses tool as the firm's investment mandate", () => {
    const descriptions = getToolDescriptions();

    expect(descriptions).toContain("get_investment_theses");
    expect(descriptions).toContain("investment mandate");
  });
});
