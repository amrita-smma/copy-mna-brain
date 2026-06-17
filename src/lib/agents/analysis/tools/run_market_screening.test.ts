import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findActive, createDb, runMarketScreening } = vi.hoisted(() => ({
  findActive: vi.fn(),
  createDb: vi.fn(),
  runMarketScreening: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({ createDb }));

vi.mock("@/lib/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repositories")>();
  class MockInvestmentThesisRepository {
    findActive = findActive;
  }
  return {
    ...actual,
    InvestmentThesisRepository: MockInvestmentThesisRepository,
  };
});

vi.mock("@/lib/jobs/handlers/marketScreening", () => ({ runMarketScreening }));

import { runMarketScreeningTool } from "./run_market_screening";

async function call(args: { sources_count?: number } = {}) {
  return runMarketScreeningTool.invoke(args as never);
}

describe("run_market_screening (workforce tool)", () => {
  beforeEach(() => {
    findActive.mockReset();
    createDb.mockReset().mockReturnValue({});
    runMarketScreening.mockReset();
  });

  afterEach(() => vi.clearAllMocks());

  it("returns 'No active investment thesis found.' when findActive returns null", async () => {
    findActive.mockResolvedValueOnce(null);

    const result = await call();

    expect(String(result)).toMatch(/No active investment thesis found/);
    expect(runMarketScreening).not.toHaveBeenCalled();
  });

  it("returns a success summary when market screening finds companies", async () => {
    findActive.mockResolvedValueOnce({ id: "thesis-1", content: "Focus on SaaS", sources_count: 7 });
    runMarketScreening.mockResolvedValueOnce({
      count: 3,
      companies: ["Acme", "Beta Corp", "Gamma Inc"],
      message: null,
    });

    const result = await call({ sources_count: 3 });

    expect(String(result)).toMatch(/Discovered 3 new acquisition target\(s\)/);
    expect(String(result)).toMatch(/Acme, Beta Corp, Gamma Inc/);
    expect(runMarketScreening).toHaveBeenCalledWith(
      { thesis: "Focus on SaaS", thesisId: "thesis-1", sourcesCount: 3 },
      { db: {} },
    );
  });

  it("returns 'no new companies' message when result.count is 0 with a message", async () => {
    findActive.mockResolvedValueOnce({ id: "thesis-1", content: "Focus on SaaS" });
    runMarketScreening.mockResolvedValueOnce({
      count: 0,
      companies: [],
      message: "No matching companies found in this scan.",
    });

    const result = await call();

    expect(String(result)).toMatch(/No matching companies found in this scan\./);
  });

  it("returns fallback message when result.count is 0 and message is null", async () => {
    findActive.mockResolvedValueOnce({ id: "thesis-1", content: "Focus on SaaS" });
    runMarketScreening.mockResolvedValueOnce({ count: 0, companies: [], message: null });

    const result = await call();

    expect(String(result)).toMatch(/no new companies were found/);
  });

  it("returns **Error:** string when runMarketScreening throws", async () => {
    findActive.mockResolvedValueOnce({ id: "thesis-1", content: "Focus on SaaS" });
    runMarketScreening.mockRejectedValueOnce(new Error("API timeout"));

    const result = await call();

    expect(String(result)).toMatch(/\*\*Error:\*\* API timeout/);
  });

  it("falls back to the thesis sources_count when no override is provided", async () => {
    findActive.mockResolvedValueOnce({ id: "thesis-1", content: "Focus on SaaS", sources_count: 8 });
    runMarketScreening.mockResolvedValueOnce({ count: 0, companies: [], message: null });

    await call();

    expect(runMarketScreening).toHaveBeenCalledWith(
      expect.objectContaining({ sourcesCount: 8 }),
      expect.anything(),
    );
  });

  it("defaults to 5 when neither an override nor a thesis count is set", async () => {
    findActive.mockResolvedValueOnce({ id: "thesis-1", content: "Focus on SaaS", sources_count: null });
    runMarketScreening.mockResolvedValueOnce({ count: 0, companies: [], message: null });

    await call();

    expect(runMarketScreening).toHaveBeenCalledWith(
      expect.objectContaining({ sourcesCount: 5 }),
      expect.anything(),
    );
  });

  it("passes an explicit sources_count override through", async () => {
    findActive.mockResolvedValueOnce({ id: "thesis-1", content: "Focus on SaaS", sources_count: 8 });
    runMarketScreening.mockResolvedValueOnce({ count: 0, companies: [], message: null });

    await call({ sources_count: 10 });

    expect(runMarketScreening).toHaveBeenCalledWith(
      expect.objectContaining({ sourcesCount: 10 }),
      expect.anything(),
    );
  });
});
