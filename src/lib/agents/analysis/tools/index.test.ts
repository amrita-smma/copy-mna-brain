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
import { SECTOR_CHAT_CORE_TOOLS, SECTOR_WORKFORCE_CORE_TOOLS } from "@/lib/agents/sector/coreTools";
import { MINERBA_TOOLS } from "@/lib/agents/minerba/tools";
import { DIKTI_TOOLS } from "@/lib/agents/dikti/tools";
import { BANGUN_TOOLS } from "@/lib/agents/bangun/tools";

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

  // ask_owner pauses a run for its owner's answer — only the workforce has
  // the HITL middleware and the intervention card that resolve it.
  it("exposes ask_owner to the workforce agent only", () => {
    expect(AGENT_TOOL_LISTS.workforce.map((t) => t.name)).toContain("ask_owner");
    for (const [flavor, list] of Object.entries(AGENT_TOOL_LISTS)) {
      if (flavor === "workforce") continue;
      expect(list.map((t) => t.name)).not.toContain("ask_owner");
    }
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

  // The AlphaSense subscription is retired. The tool module still exists (and
  // is still unit-tested) so it can be put back, but no agent registers it.
  it.each(Object.entries(AGENT_TOOL_LISTS))(
    "keeps alphasense_search out of the %s agent",
    (_label, list) => {
      expect(list.map((t) => t.name)).not.toContain("alphasense_search");
    },
  );

  it.each([
    ["chat", AGENT_TOOL_LISTS.chat],
    ["combined", AGENT_TOOL_LISTS.combined],
    ["investment", AGENT_TOOL_LISTS.investment],
    ["vc", AGENT_TOOL_LISTS.vc],
  ])("exposes the insight proposal tools, but not replace_insight_document, to the %s agent", (_label, list) => {
    const names = list.map((t) => t.name);
    expect(names).toContain("propose_insight_create");
    expect(names).toContain("propose_insight_edit");
    expect(names).not.toContain("replace_insight_document");
  });

  it.each(Object.entries(AGENT_TOOL_LISTS))(
    "does not offer propose_insight_template_create to the %s agent",
    (_label, list) => {
      expect(list.map((t) => t.name)).not.toContain("propose_insight_template_create");
    },
  );

  // Sector agents read templates (get_insight_template) but don't author them.
  it.each([
    ["sector chat core", SECTOR_CHAT_CORE_TOOLS],
    ["sector workforce core", SECTOR_WORKFORCE_CORE_TOOLS],
    ["minerba chat", MINERBA_TOOLS.chat],
    ["minerba workforce", MINERBA_TOOLS.workforce],
    ["dikti chat", DIKTI_TOOLS.chat],
    ["dikti workforce", DIKTI_TOOLS.workforce],
    ["bangun chat", BANGUN_TOOLS.chat],
    ["bangun workforce", BANGUN_TOOLS.workforce],
  ])("keeps propose_insight_template_create out of the %s tools", (_label, list) => {
    const names = list.map((t) => t.name);
    expect(names).toContain("get_insight_template");
    expect(names).not.toContain("propose_insight_template_create");
  });

  // Read-only and browser-free, so it lives in the shared base: a large
  // template-based insight is handed off, and the workforce must read the
  // template it was told to build from.
  it.each(Object.entries(AGENT_TOOL_LISTS))(
    "exposes get_insight_template to the %s agent",
    (_label, list) => {
      expect(list.map((t) => t.name)).toContain("get_insight_template");
    },
  );

  // A scheduled refresh must read the insight (or its run draft) before it
  // edits, and must be able to replace a document that has no data-section
  // blocks. The workforce writes directly, so it never gets the proposal tools.
  it("gives the workforce agent get_insight and replace_insight_document instead of the proposal tools", () => {
    const names = AGENT_TOOL_LISTS.workforce.map((t) => t.name);
    expect(names).toContain("get_insight");
    expect(names).toContain("replace_insight_document");
    expect(names).not.toContain("propose_insight_create");
    expect(names).not.toContain("propose_insight_edit");
  });

  it.each(Object.entries(AGENT_TOOL_LISTS))(
    "does not expose old dashboard tools to the %s agent",
    (_label, list) => {
      const names = list.map((t) => t.name);
      expect(names).not.toContain("propose_dashboard_create");
      expect(names).not.toContain("propose_dashboard_edit");
      expect(names).not.toContain("get_dashboard_template");
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

  it("describes the insight tools", () => {
    const descriptions = getToolDescriptions();

    expect(descriptions).toContain("propose_insight_create");
    expect(descriptions).toContain("propose_insight_edit");
  });

  // This catalogue is injected into the AI Screening and company-analysis job
  // prompts, so a stale entry would still offer the retired tool to a model.
  it("no longer advertises the retired alphasense_search", () => {
    expect(getToolDescriptions()).not.toContain("alphasense_search");
  });
});

