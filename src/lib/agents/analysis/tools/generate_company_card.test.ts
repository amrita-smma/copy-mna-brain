import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runGenerateCompanyCard, linkRelatedCompanies, createDb, createContainer } =
  vi.hoisted(() => ({
    runGenerateCompanyCard: vi.fn(),
    linkRelatedCompanies: vi.fn(),
    createDb: vi.fn(),
    createContainer: vi.fn(),
  }));

vi.mock("@/lib/server/db", () => ({ createDb }));

vi.mock("@/lib/services/container", () => ({ createContainer }));

vi.mock("@/lib/jobs/handlers/companyAnalysis", () => ({
  generateCompanyCard: runGenerateCompanyCard,
}));

import { generateCompanyCard } from "./generate_company_card";

function call(company_id: string) {
  return generateCompanyCard.invoke({ company_id });
}

describe("generate_company_card (workforce tool)", () => {
  beforeEach(() => {
    runGenerateCompanyCard.mockReset();
    linkRelatedCompanies.mockReset().mockResolvedValue([]);
    createDb.mockReset().mockReturnValue({});
    createContainer.mockReset().mockReturnValue({
      companyRelationshipService: { linkRelatedCompanies },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("rejects when company_id is blank without generating anything", async () => {
    const result = await call("   ");

    expect(String(result)).toMatch(/company_id is required/);
    expect(runGenerateCompanyCard).not.toHaveBeenCalled();
  });

  it("generates the card and links its related companies", async () => {
    const related = [
      { name: "Beta", relation_type: "SUPPLIER", notes: "wafers" },
      { name: "Gamma", relation_type: "INVESTED_IN" },
    ];
    runGenerateCompanyCard.mockResolvedValue({
      analysis: { id: "analysis-1" },
      companyName: "Acme",
      relatedCompanies: related,
    });
    linkRelatedCompanies.mockResolvedValue(['"Beta" (SUPPLIER)', '"Gamma" (INVESTED_IN)']);

    const result = await call("co-1");

    expect(runGenerateCompanyCard).toHaveBeenCalledWith({ companyId: "co-1" }, { db: {} });
    expect(linkRelatedCompanies).toHaveBeenCalledWith("Acme", related);
    expect(String(result)).toMatch(/Generated the AI Company Card for "Acme"/);
    expect(String(result)).toMatch(/Linked 2 related companies/);
  });

  it("says so when no related company was linked", async () => {
    runGenerateCompanyCard.mockResolvedValue({
      analysis: { id: "analysis-1" },
      companyName: "Acme",
      relatedCompanies: [{ name: " acme ", relation_type: "PARTNER" }],
    });

    const result = await call("co-1");

    expect(String(result)).toMatch(/No related companies were surfaced/);
  });

  it("reports a link failure but still succeeds on the card", async () => {
    runGenerateCompanyCard.mockResolvedValue({
      analysis: { id: "analysis-1" },
      companyName: "Acme",
      relatedCompanies: [{ name: "Beta", relation_type: "SUPPLIER" }],
    });
    linkRelatedCompanies.mockResolvedValue(['"Beta" — link failed: neo4j down']);

    const result = await call("co-1");

    expect(String(result)).toMatch(/Generated the AI Company Card for "Acme"/);
    expect(String(result)).toMatch(/link failed: neo4j down/);
  });

  it("returns an error string when card generation throws", async () => {
    runGenerateCompanyCard.mockRejectedValue(new Error("agent unavailable"));

    const result = await call("co-1");

    expect(String(result)).toMatch(/\*\*Error:\*\* agent unavailable/);
  });
});
