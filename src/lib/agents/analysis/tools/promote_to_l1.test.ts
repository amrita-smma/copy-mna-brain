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

async function call(args: { company_name: string; note?: string }) {
  return promoteToL1.invoke(args);
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

  it("calls companyService.promote with the correct args and reports success", async () => {
    findByNameFuzzy.mockResolvedValueOnce({
      id: "c-2",
      target: "Cinder Foods",
      pipeline_stage: "L0",
    });
    promote.mockResolvedValueOnce(undefined);

    const result = await call({
      company_name: "Cinder Foods",
      note: "User acknowledged weak FY2024 EBITDA.",
    });

    expect(promote).toHaveBeenCalledWith(
      "c-2",
      "L0",
      "L1",
      "User acknowledged weak FY2024 EBITDA.",
    );
    expect(String(result)).toMatch(/Promoted "Cinder Foods" from L0 to L1/);
    expect(String(result)).toMatch(/Note recorded/);
  });

  it("treats whitespace-only notes as no note", async () => {
    findByNameFuzzy.mockResolvedValueOnce({
      id: "c-3",
      target: "X",
      pipeline_stage: "L0",
    });
    promote.mockResolvedValueOnce(undefined);

    const result = await call({ company_name: "X", note: "   " });

    expect(promote).toHaveBeenCalledWith("c-3", "L0", "L1", undefined);
    expect(String(result)).not.toMatch(/Note recorded/);
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
