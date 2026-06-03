import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findByNameFuzzy, promote, createDb, createContainer } = vi.hoisted(
  () => ({
    findByNameFuzzy: vi.fn(),
    promote: vi.fn(),
    createDb: vi.fn(),
    createContainer: vi.fn(),
  }),
);

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
    createDb.mockReset().mockReturnValue({});
    createContainer.mockReset().mockReturnValue({
      companyService: { promote },
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
});
