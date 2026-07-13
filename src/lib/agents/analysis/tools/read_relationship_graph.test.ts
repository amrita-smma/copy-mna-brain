import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  findByNameFuzzy,
  getConnectedCompanies,
  getConnectionsAmong,
  createDb,
  createContainer,
  getActiveWorkspaceId,
} = vi.hoisted(() => ({
  findByNameFuzzy: vi.fn(),
  getConnectedCompanies: vi.fn(),
  getConnectionsAmong: vi.fn(),
  createDb: vi.fn(),
  createContainer: vi.fn(),
  getActiveWorkspaceId: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({ createDb }));
vi.mock("@/lib/services", () => ({ createContainer }));
vi.mock("@/lib/workspace", () => ({ getActiveWorkspaceId }));
vi.mock("@/lib/repositories", () => ({
  CompanyRepository: class {
    findByNameFuzzy = findByNameFuzzy;
  },
}));

import { readRelationshipGraph } from "./read_relationship_graph";

function call(companies: string[]) {
  return readRelationshipGraph.invoke({ companies } as never);
}

/** Register fuzzy-match results keyed by trimmed query. Unknown → null. */
function withCompanies(map: Record<string, { id: string; target: string }>) {
  findByNameFuzzy.mockImplementation(async (q: string) => map[q.trim()] ?? null);
}

describe("read_relationship_graph", () => {
  beforeEach(() => {
    findByNameFuzzy.mockReset();
    getConnectedCompanies.mockReset().mockResolvedValue([]);
    getConnectionsAmong.mockReset().mockResolvedValue([]);
    createDb.mockReset().mockReturnValue({});
    getActiveWorkspaceId.mockReset().mockResolvedValue("ws-1");
    createContainer.mockReset().mockReturnValue({
      companyGraphService: { getConnectedCompanies, getConnectionsAmong },
    });
  });

  afterEach(() => vi.clearAllMocks());

  it("rejects an empty company list", async () => {
    const result = await call([]);
    expect(String(result)).toMatch(/at least one company name/);
    expect(findByNameFuzzy).not.toHaveBeenCalled();
  });

  it("rejects more than the max number of companies", async () => {
    const many = Array.from({ length: 26 }, (_, i) => `C${i}`);
    const result = await call(many);
    expect(String(result)).toMatch(/too many companies/);
  });

  it("reports when no company resolves", async () => {
    withCompanies({});
    const result = await call(["Nope"]);
    expect(String(result)).toMatch(/No companies matched/);
    expect(getConnectedCompanies).not.toHaveBeenCalled();
  });

  it("lists a single company's connections grouped by direction", async () => {
    withCompanies({ Acme: { id: "acme", target: "Acme" } });
    getConnectedCompanies.mockResolvedValueOnce([
      {
        company: { id: "beta", name: "Beta" },
        type: "SELLS_TO",
        direction: "outgoing",
      },
      {
        company: { id: "gamma", name: "Gamma" },
        type: "INVESTED_IN",
        direction: "incoming",
        notes: "led round",
      },
    ]);

    const result = await call(["Acme"]);

    expect(getConnectedCompanies).toHaveBeenCalledWith("acme");
    expect(String(result)).toMatch(/Relationships for Acme/);
    expect(String(result)).toMatch(/Acme --SELLS_TO--> Beta/);
    expect(String(result)).toMatch(/Gamma --INVESTED_IN--> Acme \(led round\)/);
  });

  it("reports a single company with no relationships", async () => {
    withCompanies({ Lonely: { id: "lonely", target: "Lonely Co" } });
    const result = await call(["Lonely"]);
    expect(String(result)).toMatch(/Lonely Co\*\* has no relationships/);
  });

  it("checks every pair for a direct connection", async () => {
    withCompanies({
      Acme: { id: "acme", target: "Acme" },
      Beta: { id: "beta", target: "Beta" },
      Gamma: { id: "gamma", target: "Gamma" },
    });
    // Acme→Beta connected; Gamma isolated from both.
    getConnectionsAmong.mockResolvedValueOnce([
      { sourceId: "acme", targetId: "beta", type: "SELLS_TO" },
    ]);

    const result = await call(["Acme", "Beta", "Gamma"]);

    expect(getConnectionsAmong).toHaveBeenCalledWith(["acme", "beta", "gamma"]);
    expect(String(result)).toMatch(/1 of 3 pair\(s\) directly connected/);
    expect(String(result)).toMatch(/Acme --SELLS_TO--> Beta/);
    expect(String(result)).toMatch(/Acme ↔ Gamma/);
    expect(String(result)).toMatch(/Beta ↔ Gamma/);
  });

  it("dedupes names that resolve to the same company", async () => {
    withCompanies({
      Acme: { id: "acme", target: "Acme" },
      "Acme Corp": { id: "acme", target: "Acme" },
    });
    // Two names collapse to one company → single-company (neighbour) behaviour.
    getConnectedCompanies.mockResolvedValueOnce([]);

    const result = await call(["Acme", "Acme Corp"]);

    expect(getConnectedCompanies).toHaveBeenCalledWith("acme");
    expect(getConnectionsAmong).not.toHaveBeenCalled();
    expect(String(result)).toMatch(/has no relationships/);
  });

  it("reports unresolved names alongside resolved results", async () => {
    withCompanies({ Acme: { id: "acme", target: "Acme" } });
    getConnectedCompanies.mockResolvedValueOnce([]);

    const result = await call(["Acme", "Ghost"]);

    expect(String(result)).toMatch(/Not found \(excluded\): "Ghost"/);
  });

  it("returns an error string when the graph service throws", async () => {
    withCompanies({ Acme: { id: "acme", target: "Acme" } });
    getConnectedCompanies.mockRejectedValueOnce(new Error("neo4j down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await call(["Acme"]);

    expect(String(result)).toMatch(/\*\*Error:\*\* neo4j down/);
    errSpy.mockRestore();
  });
});
