import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findByNameFuzzy, promote, listStages, createDb, createContainer } =
  vi.hoisted(() => ({
    findByNameFuzzy: vi.fn(),
    promote: vi.fn(),
    listStages: vi.fn(),
    createDb: vi.fn(),
    createContainer: vi.fn(),
  }));

vi.mock("@/lib/server/db", () => ({ createDb }));

vi.mock("@/lib/services", () => ({ createContainer }));

vi.mock("@/lib/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repositories")>();
  class MockCompanyRepository {
    findByNameFuzzy = findByNameFuzzy;
  }
  return {
    ...actual,
    CompanyRepository: MockCompanyRepository,
  };
});

import { promoteToL1 } from "./promote_to_l1";
import type { PipelineStageDef } from "@/lib/pipeline/stages";

function stage(
  key: string,
  position: number,
  extra: Partial<PipelineStageDef> = {},
): PipelineStageDef {
  return { key, code: key, name: key, description: "", position, deleted: false, ...extra };
}

const DEFAULT_STAGES = ["L0", "L1", "L2", "L3", "L4", "L5"].map((key, i) =>
  stage(key, i),
);

const DEFAULT_REASON =
  "Revenue $42M FY2024, EBITDA margin 18%; fits APAC semicap thesis.";

async function call(args: {
  company_name: string;
  reason?: string;
  note?: string;
}) {
  return promoteToL1.invoke({
    reason: DEFAULT_REASON,
    ...args,
  });
}

describe("promote_to_l1 (workforce tool)", () => {
  beforeEach(() => {
    findByNameFuzzy.mockReset();
    promote.mockReset();
    listStages.mockReset().mockResolvedValue(DEFAULT_STAGES);
    createDb.mockReset().mockReturnValue({});
    createContainer.mockReset().mockReturnValue({
      companyService: { promote },
      pipelineStageService: { list: listStages },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("rejects whitespace-only company_name without touching the repo or service", async () => {
    const result = await call({ company_name: "   " });

    expect(String(result)).toMatch(/company_name is required/);
    expect(findByNameFuzzy).not.toHaveBeenCalled();
    expect(promote).not.toHaveBeenCalled();
  });

  it("rejects whitespace-only reason without touching the repo or service", async () => {
    const result = await call({ company_name: "Acme", reason: "   " });

    expect(String(result)).toMatch(/reason is required/);
    expect(findByNameFuzzy).not.toHaveBeenCalled();
    expect(promote).not.toHaveBeenCalled();
  });

  it("returns a not-found message when no company matches the name", async () => {
    findByNameFuzzy.mockResolvedValueOnce(null);

    const result = await call({ company_name: "Phantom Corp" });

    expect(String(result)).toMatch(/No company found matching/);
    expect(promote).not.toHaveBeenCalled();
  });

  it("refuses to promote a company that's already past L0", async () => {
    findByNameFuzzy.mockResolvedValueOnce({
      id: "c-1",
      target: "Acme",
      pipeline_stage: "L1",
    });

    const result = await call({ company_name: "Acme" });

    expect(String(result)).toMatch(/current pipeline stage is L1, expected L0/);
    expect(promote).not.toHaveBeenCalled();
  });

  it("refuses to promote a company that's been dropped", async () => {
    findByNameFuzzy.mockResolvedValueOnce({
      id: "c-1",
      target: "Halcyon Media",
      pipeline_stage: "L0",
      status: "dropped",
    });

    const result = await call({ company_name: "Halcyon Media" });

    expect(String(result)).toMatch(
      /Cannot promote "Halcyon Media": this company is dropped/,
    );
    expect(promote).not.toHaveBeenCalled();
  });

  it("refuses to promote when pipeline_stage is null (unset)", async () => {
    findByNameFuzzy.mockResolvedValueOnce({
      id: "c-1",
      target: "Acme",
      pipeline_stage: null,
    });

    const result = await call({ company_name: "Acme" });

    expect(String(result)).toMatch(/current pipeline stage is unset, expected L0/);
    expect(promote).not.toHaveBeenCalled();
  });

  it("resolves the company by project name and promotes it with the reason recorded", async () => {
    findByNameFuzzy.mockResolvedValueOnce({
      id: "c-9",
      target: "Acme Holdings",
      project_name: "Project Alpha",
      pipeline_stage: "L0",
    });
    promote.mockResolvedValueOnce(undefined);

    const result = await call({ company_name: "Project Alpha" });

    expect(findByNameFuzzy).toHaveBeenCalledWith("Project Alpha");
    expect(promote).toHaveBeenCalledWith(
      "c-9",
      "L0",
      "L1",
      `Reason: ${DEFAULT_REASON}`,
      undefined,
      undefined,
      undefined,
      DEFAULT_REASON,
    );
    expect(String(result)).toMatch(/Promoted "Acme Holdings" from L0 to L1/);
  });

  it("records reason and note together when both are passed", async () => {
    findByNameFuzzy.mockResolvedValueOnce({
      id: "c-2",
      target: "Cinder Foods",
      pipeline_stage: "L0",
    });
    promote.mockResolvedValueOnce(undefined);

    const result = await call({
      company_name: "Cinder Foods",
      reason: "Strong FY2024 revenue growth (32% YoY); EBITDA margin 21%.",
      note: "User acknowledged weak FY2023 EBITDA.",
    });

    expect(promote).toHaveBeenCalledWith(
      "c-2",
      "L0",
      "L1",
      "Reason: Strong FY2024 revenue growth (32% YoY); EBITDA margin 21%.\n\nNote: User acknowledged weak FY2023 EBITDA.",
      undefined,
      undefined,
      undefined,
      "Strong FY2024 revenue growth (32% YoY); EBITDA margin 21%.",
    );
    expect(String(result)).toMatch(/Promoted "Cinder Foods" from L0 to L1/);
  });

  it("treats whitespace-only notes as no note", async () => {
    findByNameFuzzy.mockResolvedValueOnce({
      id: "c-3",
      target: "X",
      pipeline_stage: "L0",
    });
    promote.mockResolvedValueOnce(undefined);

    await call({ company_name: "X", note: "   " });

    expect(promote).toHaveBeenCalledWith(
      "c-3",
      "L0",
      "L1",
      `Reason: ${DEFAULT_REASON}`,
      undefined,
      undefined,
      undefined,
      DEFAULT_REASON,
    );
  });

  it("returns an **Error:** string when the service throws (does not propagate)", async () => {
    findByNameFuzzy.mockResolvedValueOnce({
      id: "c-4",
      target: "Acme",
      pipeline_stage: "L0",
    });
    promote.mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await call({ company_name: "Acme" });

    expect(String(result)).toMatch(/\*\*Error:\*\* db down/);
    errSpy.mockRestore();
  });

  it("explains that the target stage was just deleted instead of returning a raw error", async () => {
    findByNameFuzzy.mockResolvedValue({ id: "c1", target: "Acme", pipeline_stage: "L0", status: "active" });
    const { PipelineStageUnavailableError } = await import("@/lib/services/companyService");
    promote.mockImplementation(async () => {
      throw new PipelineStageUnavailableError("L1");
    });

    const result = String(await call({ company_name: "Acme" }));

    expect(result).toMatch(/Cannot promote "Acme" to L1: this workspace has just deleted that stage/);
    expect(result).not.toMatch(/\*\*Error:\*\*/);
  });

  it("promotes into a stage the workspace inserted after L0, named by its code", async () => {
    listStages.mockResolvedValueOnce([
      stage("L0", 0),
      stage("stg-a1b2", 1, { code: "L0b" }),
      stage("L1", 2),
    ]);
    findByNameFuzzy.mockResolvedValueOnce({ id: "c-5", target: "Acme", pipeline_stage: "L0" });
    promote.mockResolvedValueOnce(undefined);

    const result = String(await call({ company_name: "Acme" }));

    expect(promote).toHaveBeenCalledWith(
      "c-5",
      "L0",
      "stg-a1b2",
      `Reason: ${DEFAULT_REASON}`,
      undefined,
      undefined,
      undefined,
      DEFAULT_REASON,
    );
    expect(result).toMatch(/Promoted "Acme" from L0 to L0b/);
    expect(result).not.toMatch(/stg-/);
  });

  it("promotes into whatever follows L0 when the workspace deleted L1", async () => {
    listStages.mockResolvedValueOnce([
      stage("L0", 0),
      stage("L1", 1, { deleted: true }),
      stage("L2", 2),
    ]);
    findByNameFuzzy.mockResolvedValueOnce({ id: "c-6", target: "Acme", pipeline_stage: "L0" });
    promote.mockResolvedValueOnce(undefined);

    const result = String(await call({ company_name: "Acme" }));

    expect(promote.mock.calls[0]?.[2]).toBe("L2");
    expect(result).toMatch(/Promoted "Acme" from L0 to L2/);
  });

  it("refuses without promoting when L0 is the workspace's only live stage", async () => {
    listStages.mockResolvedValueOnce([stage("L0", 0), stage("L1", 1, { deleted: true })]);
    findByNameFuzzy.mockResolvedValueOnce({ id: "c-7", target: "Acme", pipeline_stage: "L0" });

    const result = String(await call({ company_name: "Acme" }));

    expect(result).toMatch(/^Cannot promote "Acme": this workspace has no pipeline stage after L0/);
    expect(promote).not.toHaveBeenCalled();
  });
});
