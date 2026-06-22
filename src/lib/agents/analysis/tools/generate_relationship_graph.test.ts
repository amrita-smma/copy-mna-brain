import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { linkByName, createDb, createContainer } = vi.hoisted(() => ({
  linkByName: vi.fn(),
  createDb: vi.fn(),
  createContainer: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({ createDb }));

vi.mock("@/lib/services", () => ({ createContainer }));

import { generateRelationshipGraph } from "./generate_relationship_graph";

interface EdgeArg {
  source_company: string;
  target_company: string;
  relation_type?: "INVESTED_IN" | "PARTNER" | "SUPPLIER";
  notes?: string;
  evidence?: string;
  date?: string;
}

function call(edges: EdgeArg[]) {
  return generateRelationshipGraph.invoke({
    edges: edges.map((e) => ({ relation_type: "PARTNER", ...e })),
  } as never);
}

// Convenience: a linkByName resolution where both sides already existed.
function linked(sourceName: string, targetName: string) {
  return {
    source: { row: { id: `${sourceName}-id`, target: sourceName }, created: false },
    target: { row: { id: `${targetName}-id`, target: targetName }, created: false },
  };
}

describe("generate_relationship_graph (workforce tool)", () => {
  beforeEach(() => {
    linkByName.mockReset();
    createDb.mockReset().mockReturnValue({});
    createContainer.mockReset().mockReturnValue({
      companyRelationshipService: { linkByName },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("rejects an empty edge list without touching the service", async () => {
    const result = await call([]);
    expect(String(result)).toMatch(/at least one edge is required/);
    expect(linkByName).not.toHaveBeenCalled();
  });

  it("writes every valid edge and reports the count", async () => {
    linkByName
      .mockResolvedValueOnce(linked("Acme", "Beta"))
      .mockResolvedValueOnce(linked("Acme", "Gamma"));

    const result = await call([
      { source_company: "Acme", target_company: "Beta", relation_type: "SUPPLIER" },
      { source_company: "Acme", target_company: "Gamma", relation_type: "PARTNER" },
    ]);

    expect(linkByName).toHaveBeenCalledTimes(2);
    expect(String(result)).toMatch(/Wrote 2\/2 edge\(s\)/);
    expect(String(result)).toMatch(/"Acme" --SUPPLIER--> "Beta"/);
    expect(String(result)).toMatch(/"Acme" --PARTNER--> "Gamma"/);
  });

  it("flags companies created as discovered, deduping repeats", async () => {
    linkByName
      .mockResolvedValueOnce({
        source: { row: { id: "a", target: "Acme" }, created: false },
        target: { row: { id: "b", target: "Beta" }, created: true },
      })
      .mockResolvedValueOnce({
        source: { row: { id: "a", target: "Acme" }, created: false },
        target: { row: { id: "b", target: "Beta" }, created: true },
      });

    const result = await call([
      { source_company: "Acme", target_company: "Beta", relation_type: "SUPPLIER" },
      { source_company: "Acme", target_company: "Beta", relation_type: "PARTNER" },
    ]);

    expect(String(result)).toMatch(/Created 1 company\(ies\) as "discovered"/);
    expect(String(result)).toMatch(/Beta/);
  });

  it("skips invalid edges (self-relation, blanks) but processes the rest", async () => {
    linkByName.mockResolvedValueOnce(linked("Acme", "Beta"));

    const result = await call([
      { source_company: "Solo", target_company: " solo " },
      { source_company: "Blank", target_company: "   " },
      { source_company: "Acme", target_company: "Beta", relation_type: "SUPPLIER" },
    ]);

    expect(linkByName).toHaveBeenCalledTimes(1);
    expect(String(result)).toMatch(/Wrote 1\/3 edge\(s\)/);
    expect(String(result)).toMatch(/Skipped 2/);
    expect(String(result)).toMatch(/source and target must differ/);
    expect(String(result)).toMatch(/both source_company and target_company are required/);
  });

  it("captures a per-edge service failure without aborting the batch", async () => {
    linkByName
      .mockRejectedValueOnce(new Error("neo4j down"))
      .mockResolvedValueOnce(linked("Acme", "Gamma"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await call([
      { source_company: "Acme", target_company: "Beta" },
      { source_company: "Acme", target_company: "Gamma" },
    ]);

    expect(linkByName).toHaveBeenCalledTimes(2);
    expect(String(result)).toMatch(/Wrote 1\/2 edge\(s\)/);
    expect(String(result)).toMatch(/neo4j down/);
    errSpy.mockRestore();
  });

  it("passes trimmed notes/evidence/date through to the service", async () => {
    linkByName.mockResolvedValueOnce(linked("Acme", "Beta"));

    await call([
      {
        source_company: "Acme",
        target_company: "Beta",
        relation_type: "INVESTED_IN",
        notes: "  led the round  ",
        evidence: " https://example.com ",
        date: " 2024-01-15 ",
      },
    ]);

    expect(linkByName).toHaveBeenCalledWith({
      sourceName: "Acme",
      targetName: "Beta",
      type: "INVESTED_IN",
      notes: "led the round",
      evidence: "https://example.com",
      date: "2024-01-15",
    });
  });
});
