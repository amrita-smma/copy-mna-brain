import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runGenerateCompanyCard, linkByName, createDb, createContainer } =
  vi.hoisted(() => ({
    runGenerateCompanyCard: vi.fn(),
    linkByName: vi.fn(),
    createDb: vi.fn(),
    createContainer: vi.fn(),
  }));

vi.mock("@/lib/server/db", () => ({ createDb }));

vi.mock("@/lib/services", () => ({ createContainer }));

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
    linkByName.mockReset().mockResolvedValue({
      source: { row: { id: "src", target: "Acme" }, created: false },
      target: { row: { id: "tgt", target: "Beta" }, created: false },
    });
    createDb.mockReset().mockReturnValue({});
    createContainer.mockReset().mockReturnValue({
      companyRelationshipService: { linkByName },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("rejects when company_id is blank without generating anything", async () => {
    const result = await call("   ");

    expect(String(result)).toMatch(/company_id is required/);
    expect(runGenerateCompanyCard).not.toHaveBeenCalled();
  });

  it("generates the card and links each related company", async () => {
    runGenerateCompanyCard.mockResolvedValue({
      analysis: { id: "analysis-1" },
      companyName: "Acme",
      relatedCompanies: [
        { name: "Beta", relation_type: "SUPPLIER", notes: "wafers" },
        { name: "Gamma", relation_type: "INVESTED_IN" },
      ],
    });

    const result = await call("co-1");

    expect(runGenerateCompanyCard).toHaveBeenCalledWith({ companyId: "co-1" }, { db: {} });
    expect(linkByName).toHaveBeenCalledTimes(2);
    expect(linkByName).toHaveBeenNthCalledWith(1, {
      sourceName: "Acme",
      targetName: "Beta",
      type: "SUPPLIER",
      notes: "wafers",
      evidence: undefined,
    });
    expect(String(result)).toMatch(/Generated the AI Company Card for "Acme"/);
    expect(String(result)).toMatch(/Linked 2 related companies/);
  });

  it("skips a related company that is the same as the analysed company", async () => {
    runGenerateCompanyCard.mockResolvedValue({
      analysis: { id: "analysis-1" },
      companyName: "Acme",
      relatedCompanies: [{ name: " acme ", relation_type: "PARTNER" }],
    });

    const result = await call("co-1");

    expect(linkByName).not.toHaveBeenCalled();
    expect(String(result)).toMatch(/No related companies were surfaced/);
  });

  it("reports a link failure but still succeeds on the card", async () => {
    runGenerateCompanyCard.mockResolvedValue({
      analysis: { id: "analysis-1" },
      companyName: "Acme",
      relatedCompanies: [{ name: "Beta", relation_type: "SUPPLIER" }],
    });
    linkByName.mockRejectedValueOnce(new Error("neo4j down"));

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
