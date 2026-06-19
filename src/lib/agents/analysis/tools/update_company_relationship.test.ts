import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findByNameFuzzy, create, relateCompanies, createDb, createContainer } =
  vi.hoisted(() => ({
    findByNameFuzzy: vi.fn(),
    create: vi.fn(),
    relateCompanies: vi.fn(),
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

import { updateCompanyRelationship } from "./update_company_relationship";

function call(args: {
  source_company: string;
  target_company: string;
  relation_type?: "INVESTED_IN" | "PARTNER" | "SUPPLIER";
  notes?: string;
  evidence?: string;
  date?: string;
}) {
  return updateCompanyRelationship.invoke({
    relation_type: "PARTNER",
    ...args,
  });
}

describe("update_company_relationship (workforce tool)", () => {
  beforeEach(() => {
    findByNameFuzzy.mockReset();
    create.mockReset();
    relateCompanies.mockReset().mockResolvedValue(undefined);
    createDb.mockReset().mockReturnValue({});
    createContainer.mockReset().mockReturnValue({
      companyService: { create },
      companyGraphService: { relateCompanies },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("rejects when either company name is blank, without touching the repo", async () => {
    const result = await call({ source_company: "Acme", target_company: "   " });

    expect(String(result)).toMatch(/both source_company and target_company are required/);
    expect(findByNameFuzzy).not.toHaveBeenCalled();
    expect(relateCompanies).not.toHaveBeenCalled();
  });

  it("rejects a self-relation (same company on both sides)", async () => {
    const result = await call({ source_company: "Acme", target_company: " acme " });

    expect(String(result)).toMatch(/must be different companies/);
    expect(findByNameFuzzy).not.toHaveBeenCalled();
    expect(relateCompanies).not.toHaveBeenCalled();
  });

  it("links two existing companies without creating any rows", async () => {
    findByNameFuzzy
      .mockResolvedValueOnce({ id: "src-1", target: "Acme" })
      .mockResolvedValueOnce({ id: "tgt-1", target: "Beta" });

    const result = await call({
      source_company: "Acme",
      target_company: "Beta",
      relation_type: "INVESTED_IN",
      notes: "Series B lead",
    });

    expect(create).not.toHaveBeenCalled();
    expect(relateCompanies).toHaveBeenCalledWith({
      source: { id: "src-1", target: "Acme" },
      target: { id: "tgt-1", target: "Beta" },
      type: "INVESTED_IN",
      notes: "Series B lead",
      evidence: undefined,
      date: undefined,
    });
    expect(String(result)).toMatch(/Linked "Acme" --INVESTED_IN--> "Beta"/);
  });

  it("creates a discovered company for an unmatched side and links it", async () => {
    findByNameFuzzy
      .mockResolvedValueOnce({ id: "src-1", target: "Acme" }) // source exists
      .mockResolvedValueOnce(null); // target missing
    create.mockResolvedValueOnce({ id: "new-1", target: "Ghost Corp" });

    const result = await call({
      source_company: "Acme",
      target_company: "Ghost Corp",
      relation_type: "SUPPLIER",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "Ghost Corp",
        pipeline_stage: "discovered",
        status: "active",
      }),
      "CREATED_AS_DISCOVERED",
    );
    expect(relateCompanies).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { id: "src-1", target: "Acme" },
        target: { id: "new-1", target: "Ghost Corp" },
        type: "SUPPLIER",
      }),
    );
    expect(String(result)).toMatch(/created it as a "discovered" company/);
  });

  it("returns an error string when the graph write throws", async () => {
    findByNameFuzzy
      .mockResolvedValueOnce({ id: "src-1", target: "Acme" })
      .mockResolvedValueOnce({ id: "tgt-1", target: "Beta" });
    relateCompanies.mockRejectedValueOnce(new Error("neo4j down"));

    const result = await call({ source_company: "Acme", target_company: "Beta" });

    expect(String(result)).toMatch(/\*\*Error:\*\* neo4j down/);
  });
});
