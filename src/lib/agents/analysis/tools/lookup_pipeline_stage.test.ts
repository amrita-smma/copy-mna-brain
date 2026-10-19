import { beforeEach, describe, expect, it, vi } from "vitest";

const { findByNameFuzzy, listStages, createContainer } = vi.hoisted(() => ({
  findByNameFuzzy: vi.fn(),
  listStages: vi.fn(),
  createContainer: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({ createDb: vi.fn(() => ({})) }));
vi.mock("@/lib/workspace", () => ({ getActiveWorkspaceId: vi.fn(async () => "ws-1") }));
vi.mock("@/lib/services/container", () => ({ createContainer }));
vi.mock("@/lib/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repositories")>();
  class MockCompanyRepository {
    findByNameFuzzy = findByNameFuzzy;
  }
  return { ...actual, CompanyRepository: MockCompanyRepository };
});

import { lookupPipelineStage } from "./lookup_pipeline_stage";
import type { PipelineStageDef } from "@/lib/pipeline/stages";

function stage(key: string, position: number): PipelineStageDef {
  return { key, code: key, name: `${key} name`, description: "", position, deleted: false };
}

const STAGES = ["L0", "L1", "L2"].map((key, i) => stage(key, i));

function company(extra: Record<string, unknown> = {}) {
  return { id: "c-1", target: "Acme Corp", project_name: null, status: "active", pipeline_stage: "L0", ...extra };
}

describe("lookup_pipeline_stage (workforce tool)", () => {
  beforeEach(() => {
    findByNameFuzzy.mockReset();
    listStages.mockReset().mockResolvedValue(STAGES);
    createContainer.mockReset().mockReturnValue({ pipelineStageService: { list: listStages } });
  });

  it("rejects an empty company_name without touching the repo", async () => {
    const result = await lookupPipelineStage.invoke({ company_name: "  " });
    expect(String(result)).toMatch(/company_name is required/);
    expect(findByNameFuzzy).not.toHaveBeenCalled();
  });

  it("returns a not-found message when nothing matches", async () => {
    findByNameFuzzy.mockResolvedValueOnce(null);
    const result = await lookupPipelineStage.invoke({ company_name: "Phantom" });
    expect(String(result)).toMatch(/No company found matching "Phantom"/);
  });

  it("reports the current stage, the ordered ladder and the previous / next stages", async () => {
    findByNameFuzzy.mockResolvedValueOnce(company());
    const result = String(await lookupPipelineStage.invoke({ company_name: "Acme" }));

    expect(result).toContain("current stage: **L0 · L0 name** (key `L0`)");
    expect(result).toMatch(/\| 1 \| Pending Confirmation \| unreviewed \| previous \|/);
    expect(result).toMatch(/\| 2 \| L0 · L0 name \| L0 \| ← current \|/);
    expect(result).toMatch(/\| 3 \| L1 · L1 name \| L1 \| next \|/);
    expect(result).toContain("Previous stage: Pending Confirmation (`unreviewed`) — moves without approval");
    expect(result).toContain("Next stage: L1 · L1 name (`L1`) — requires human approval");
    expect(result).toContain('from_stage: "L0"');
  });

  it("offers both Pending Confirmation and L0 to an intake company", async () => {
    findByNameFuzzy.mockResolvedValueOnce(company({ pipeline_stage: "market_screening" }));
    const result = String(await lookupPipelineStage.invoke({ company_name: "Acme" }));
    expect(result).toContain('to_stage set to one of: "unreviewed", "L0"');
  });

  it("says a dropped company cannot be moved", async () => {
    findByNameFuzzy.mockResolvedValueOnce(company({ status: "dropped" }));
    const result = String(await lookupPipelineStage.invoke({ company_name: "Acme" }));
    expect(result).toMatch(/dropped\*\* and read-only/);
    expect(result).not.toContain("call move_stage with");
  });

  it("appends a company mention manifest so the trace can offer an Open chip", async () => {
    findByNameFuzzy.mockResolvedValueOnce(company());
    const result = String(await lookupPipelineStage.invoke({ company_name: "Acme" }));
    expect(result).toContain('COMPANY_MENTIONS_JSON:[{"id":"c-1","name":"Acme Corp"}]');
  });
});
