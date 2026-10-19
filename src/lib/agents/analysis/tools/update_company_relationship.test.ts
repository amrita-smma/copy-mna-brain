import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { linkByName, createDb, createContainer } = vi.hoisted(() => ({
  linkByName: vi.fn(),
  createDb: vi.fn(),
  createContainer: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({ createDb }));

vi.mock("@/lib/services/container", () => ({ createContainer }));

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
    linkByName.mockReset().mockResolvedValue(undefined);
    createDb.mockReset().mockReturnValue({});
    createContainer.mockReset().mockReturnValue({
      companyRelationshipService: { linkByName },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("rejects when either company name is blank, without touching the service", async () => {
    const result = await call({ source_company: "Acme", target_company: "   " });

    expect(String(result)).toMatch(/both source_company and target_company are required/);
    expect(linkByName).not.toHaveBeenCalled();
  });

  it("rejects a self-relation (same company on both sides)", async () => {
    const result = await call({ source_company: "Acme", target_company: " acme " });

    expect(String(result)).toMatch(/must be different companies/);
    expect(linkByName).not.toHaveBeenCalled();
  });

  it("links two existing companies without flagging any as discovered", async () => {
    linkByName.mockResolvedValueOnce({
      source: { row: { id: "src-1", target: "Acme" }, created: false },
      target: { row: { id: "tgt-1", target: "Beta" }, created: false },
    });

    const result = await call({
      source_company: "Acme",
      target_company: "Beta",
      relation_type: "INVESTED_IN",
      notes: "Series B lead",
    });

    expect(linkByName).toHaveBeenCalledWith({
      sourceName: "Acme",
      targetName: "Beta",
      type: "INVESTED_IN",
      notes: "Series B lead",
      evidence: undefined,
      date: undefined,
    });
    expect(String(result)).toMatch(/Linked "Acme" --INVESTED_IN--> "Beta"/);
    expect(String(result)).not.toMatch(/discovered/);
  });

  it("flags a side that was created as a discovered company", async () => {
    linkByName.mockResolvedValueOnce({
      source: { row: { id: "src-1", target: "Acme" }, created: false },
      target: { row: { id: "new-1", target: "Ghost Corp" }, created: true },
    });

    const result = await call({
      source_company: "Acme",
      target_company: "Ghost Corp",
      relation_type: "SUPPLIER",
    });

    expect(String(result)).toMatch(/created it as a "discovered" company/);
  });

  it("returns an error string when the link throws", async () => {
    linkByName.mockRejectedValueOnce(new Error("neo4j down"));

    const result = await call({ source_company: "Acme", target_company: "Beta" });

    expect(String(result)).toMatch(/\*\*Error:\*\* neo4j down/);
  });
});
