import { beforeEach, describe, expect, it, vi } from "vitest";

const { findByNameFuzzy, promote, update, listStages, createContainer, interrupt } = vi.hoisted(() => ({
  findByNameFuzzy: vi.fn(),
  promote: vi.fn(),
  update: vi.fn(),
  listStages: vi.fn(),
  createContainer: vi.fn(),
  interrupt: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({ createDb: vi.fn(() => ({})) }));
vi.mock("@/lib/workspace", () => ({ getActiveWorkspaceId: vi.fn(async () => "ws-1") }));
vi.mock("@/lib/services/container", () => ({ createContainer }));
vi.mock("@langchain/langgraph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@langchain/langgraph")>();
  return { ...actual, interrupt };
});
vi.mock("@/lib/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repositories")>();
  class MockCompanyRepository {
    findByNameFuzzy = findByNameFuzzy;
  }
  return { ...actual, CompanyRepository: MockCompanyRepository };
});

import { moveStage } from "./move_stage";
import { PipelineStageUnavailableError } from "@/lib/services/companyService";
import type { PipelineStageDef } from "@/lib/pipeline/stages";

function stage(key: string, position: number): PipelineStageDef {
  return { key, code: key, name: `${key} name`, description: "", position, deleted: false };
}

const STAGES = ["L0", "L1", "L2"].map((key, i) => stage(key, i));

function company(extra: Record<string, unknown> = {}) {
  return {
    id: "c-1",
    target: "Acme Corp",
    project_name: null,
    status: "active",
    pipeline_stage: "L0",
    source: "outbound",
    ...extra,
  };
}

async function call(args: Record<string, unknown>, runtime?: { configurable?: Record<string, unknown> }) {
  return String(
    await moveStage.invoke(
      { company_name: "Acme", from_stage: "L0", to_stage: "L1", reason: "Strong FY24 margins", ...args },
      runtime,
    ),
  );
}

describe("move_stage (workforce tool)", () => {
  beforeEach(() => {
    findByNameFuzzy.mockReset();
    promote.mockReset().mockResolvedValue(undefined);
    update.mockReset().mockResolvedValue(undefined);
    interrupt.mockReset();
    listStages.mockReset().mockResolvedValue(STAGES);
    createContainer.mockReset().mockReturnValue({
      companyService: { promote, update },
      pipelineStageService: { list: listStages },
    });
  });

  it("refuses inside an AI Screening task without touching the repo", async () => {
    const result = await call({}, { configurable: { agent_name: "ai_screening" } });
    expect(result).toMatch(/not allowed in an AI Screening task/);
    expect(findByNameFuzzy).not.toHaveBeenCalled();
  });

  it("requires a non-empty reason", async () => {
    const result = await call({ reason: "   " });
    expect(result).toMatch(/reason is required/);
    expect(findByNameFuzzy).not.toHaveBeenCalled();
  });

  it("refuses a dropped company", async () => {
    findByNameFuzzy.mockResolvedValueOnce(company({ status: "dropped" }));
    expect(await call({})).toMatch(/dropped and is read-only/);
    expect(promote).not.toHaveBeenCalled();
  });

  it("refuses when from_stage no longer matches and points back at the lookup", async () => {
    findByNameFuzzy.mockResolvedValueOnce(company({ pipeline_stage: "L1" }));
    const result = await call({ from_stage: "L0", to_stage: "L1" });
    expect(result).toMatch(/Cannot move "Acme Corp": it is at L1 · L1 name/);
    expect(result).toMatch(/Call lookup_pipeline_stage again/);
    expect(promote).not.toHaveBeenCalled();
  });

  it("refuses a move that skips a stage", async () => {
    findByNameFuzzy.mockResolvedValueOnce(company());
    const result = await call({ to_stage: "L2" });
    expect(result).toMatch(/one stage at a time/);
    expect(result).toMatch(/Allowed from here: Pending Confirmation \("unreviewed"\), L1 · L1 name \("L1"\)/);
    expect(promote).not.toHaveBeenCalled();
    expect(interrupt).not.toHaveBeenCalled();
  });

  it("moves Pending Confirmation → L0 without asking for approval", async () => {
    findByNameFuzzy.mockResolvedValueOnce(company({ pipeline_stage: "unreviewed" }));
    const result = await call({ from_stage: "unreviewed", to_stage: "L0" });

    expect(interrupt).not.toHaveBeenCalled();
    expect(promote).toHaveBeenCalledWith(
      "c-1",
      "unreviewed",
      "L0",
      "Reason: Strong FY24 margins",
      undefined,
      undefined,
      undefined,
      "Strong FY24 margins",
    );
    expect(result).toMatch(/^Moved "Acme Corp" from Pending Confirmation to L0 · L0 name/);
    expect(result).toContain("COMPANY_MENTIONS_JSON");
  });

  it("moves L0 back to Pending Confirmation without approval or a promotion reason", async () => {
    findByNameFuzzy.mockResolvedValueOnce(company());
    await call({ to_stage: "unreviewed", note: "teaser withdrawn" });

    expect(interrupt).not.toHaveBeenCalled();
    expect(promote).toHaveBeenCalledWith(
      "c-1",
      "L0",
      "unreviewed",
      "Reason: Strong FY24 margins\n\nNote: teaser withdrawn",
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });

  it("fills missing L0 entry fields when an intake company enters L0", async () => {
    findByNameFuzzy.mockResolvedValueOnce(company({ pipeline_stage: "market_screening", source: null }));
    await call({ from_stage: "market_screening", to_stage: "L0", segment: " Semiconductor ", deal_type: "Majority" });

    expect(update).toHaveBeenCalledWith("c-1", {
      segment: "Semiconductor",
      deal_type: "majority",
      source: "outbound",
    });
    expect(promote).toHaveBeenCalled();
  });

  it("refuses an unknown deal_type rather than writing it", async () => {
    findByNameFuzzy.mockResolvedValueOnce(company({ pipeline_stage: "discovered" }));
    const result = await call({ from_stage: "discovered", to_stage: "L0", deal_type: "Banana" });
    expect(result).toMatch(/deal_type must be one of/);
    expect(update).not.toHaveBeenCalled();
    expect(promote).not.toHaveBeenCalled();
  });

  it("pauses for approval on L0 → L1 with a HITLRequest the decision route understands", async () => {
    findByNameFuzzy.mockResolvedValueOnce(company());
    interrupt.mockReturnValueOnce({ decisions: [{ type: "approve" }] });

    const result = await call({});

    expect(interrupt).toHaveBeenCalledWith({
      actionRequests: [
        {
          name: "move_stage",
          args: expect.objectContaining({
            company_name: "Acme",
            from_stage: "L0",
            to_stage: "L1",
            from_label: "L0 · L0 name",
            to_label: "L1 · L1 name",
          }),
          description: "Move Acme Corp from L0 · L0 name to L1 · L1 name?",
        },
      ],
      reviewConfigs: [{ actionName: "move_stage", allowedDecisions: ["approve", "reject"] }],
    });
    expect(promote).toHaveBeenCalledWith(
      "c-1",
      "L0",
      "L1",
      "Reason: Strong FY24 margins",
      undefined,
      undefined,
      undefined,
      "Strong FY24 margins",
    );
    expect(result).toMatch(/^Moved "Acme Corp" from L0 · L0 name to L1 · L1 name/);
  });

  it("gates a move back out of L1+ too", async () => {
    findByNameFuzzy.mockResolvedValueOnce(company({ pipeline_stage: "L2" }));
    interrupt.mockReturnValueOnce({ decisions: [{ type: "approve" }] });
    await call({ from_stage: "L2", to_stage: "L1" });
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(promote).toHaveBeenCalledWith("c-1", "L2", "L1", expect.any(String), undefined, undefined, undefined, undefined);
  });

  it("writes nothing when the reviewer rejects, and passes their note to the agent", async () => {
    findByNameFuzzy.mockResolvedValueOnce(company());
    interrupt.mockReturnValueOnce({ decisions: [{ type: "reject", message: "EBITDA too weak" }] });

    const result = await call({});

    expect(promote).not.toHaveBeenCalled();
    expect(result).toMatch(/^The reviewer rejected moving "Acme Corp"/);
    expect(result).toContain('Their note: "EBITDA too weak"');
    expect(result).toMatch(/Do not retry/);
  });

  it("lets the interrupt's pause propagate instead of returning it as a tool error", async () => {
    findByNameFuzzy.mockResolvedValueOnce(company());
    const pause = new Error("GraphInterrupt");
    interrupt.mockImplementationOnce(() => {
      throw pause;
    });
    await expect(call({})).rejects.toBe(pause);
    expect(promote).not.toHaveBeenCalled();
  });

  it("explains a stage deleted between the lookup and the write", async () => {
    findByNameFuzzy.mockResolvedValueOnce(company({ pipeline_stage: "unreviewed" }));
    promote.mockRejectedValueOnce(new PipelineStageUnavailableError("L0"));
    const result = await call({ from_stage: "unreviewed", to_stage: "L0" });
    expect(result).toMatch(/has just deleted that stage/);
  });
});
