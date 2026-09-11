import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createDb,
  updateAsset,
  findById,
  findSeriesByTarget,
  findQueueById,
  FlAssetRepository,
  FlValuationRepository,
  AiWorkforceQueueRepository,
} = vi.hoisted(() => {
  const updateAsset = vi.fn();
  const findById = vi.fn();
  const findSeriesByTarget = vi.fn();
  const findQueueById = vi.fn();
  class FlAssetRepository {
    update = updateAsset;
    findById = findById;
  }
  class FlValuationRepository {
    findSeriesByTarget = findSeriesByTarget;
  }
  class AiWorkforceQueueRepository {
    findById = findQueueById;
    static isTerminal(status: string) {
      return ["succeeded", "failed", "rejected", "timed_out"].includes(status);
    }
  }
  return {
    createDb: vi.fn(),
    updateAsset,
    findById,
    findSeriesByTarget,
    findQueueById,
    FlAssetRepository,
    FlValuationRepository,
    AiWorkforceQueueRepository,
  };
});

vi.mock("@/lib/server/db", () => ({ createDb }));

vi.mock("@/lib/workspace", () => ({
  getActiveWorkspaceId: vi.fn(async () => "ws-1"),
}));

vi.mock("@/lib/repositories", () => ({
  FlAssetRepository,
  FlValuationRepository,
  AiWorkforceQueueRepository,
}));

import { saveFundAiOpinion } from "./save_fund_ai_opinion";

const RICH_ASSET = {
  id: "asset-1",
  workspace_id: "ws-1",
  sector: "Robotics",
  country: "Singapore",
  description: "Series B lead.",
  instrument_terms: {
    custom: "value",
    aiOpinion: {
      status: "processing",
    },
  },
};

const RICH_VALUATIONS = [
  { as_of_date: "2024-12-31", market_value: "800000.00" },
  { as_of_date: "2024-06-30", market_value: "700000.00" },
  { as_of_date: "2023-12-31", market_value: "600000.00" },
];

function call(
  args: {
    asset_id?: string;
    fund_asset_id?: string;
    verdict: string;
    summary: string;
    confidence: string;
  },
  config?: { configurable?: { thread_id?: string } },
) {
  return saveFundAiOpinion.invoke(args as never, config as never);
}

describe("save_fund_ai_opinion", () => {
  beforeEach(() => {
    createDb.mockReset().mockReturnValue({});
    updateAsset.mockReset().mockResolvedValue({ id: "asset-1" });
    findById.mockReset().mockResolvedValue(RICH_ASSET);
    findSeriesByTarget.mockReset().mockResolvedValue(RICH_VALUATIONS);
    findQueueById.mockReset().mockResolvedValue({ id: "run-1", status: "running" });
  });

  afterEach(() => vi.restoreAllMocks());

  it("rejects a blank asset_id without touching the repository", async () => {
    const result = await call({
      asset_id: " ",
      verdict: "buy",
      summary: "x",
      confidence: "high",
    });
    expect(String(result)).toMatch(/asset_id is required/);
    expect(updateAsset).not.toHaveBeenCalled();
  });

  it("rejects a blank summary without touching the repository", async () => {
    const result = await call({
      asset_id: "asset-1",
      verdict: "sell",
      summary: "   ",
      confidence: "medium",
    });
    expect(String(result)).toMatch(/summary is required/);
    expect(updateAsset).not.toHaveBeenCalled();
  });

  it("rejects an invalid verdict at the schema layer without touching the repository", async () => {
    await expect(
      call({
        asset_id: "asset-1",
        verdict: "pass" as never,
        summary: "x",
        confidence: "high",
      }),
    ).rejects.toThrow(/Received tool input did not match expected schema/);
    expect(updateAsset).not.toHaveBeenCalled();
  });

  it("writes the verdict, summary, confidence, and completed status onto fl_assets.instrument_terms", async () => {
    const result = await call({
      asset_id: "asset-1",
      verdict: "buy",
      summary: "Strong growth trajectory and healthy MOIC.",
      confidence: "high",
    });

    expect(updateAsset).toHaveBeenCalledTimes(1);
    const [workspaceId, id, updates] = updateAsset.mock.calls[0];
    expect(workspaceId).toBe("ws-1");
    expect(id).toBe("asset-1");
    expect(updates).toMatchObject({
      instrument_terms: expect.objectContaining({
        custom: "value",
        aiOpinion: expect.objectContaining({
          verdict: "buy",
          summary: "Strong growth trajectory and healthy MOIC.",
          status: "completed",
        }),
      }),
    });
    expect(String(result)).toMatch(/Saved AI Opinion for asset_id "asset-1": BUY/);
  });

  it("accepts fund_asset_id as an alias for backwards compatibility", async () => {
    const result = await call({
      fund_asset_id: "asset-1",
      verdict: "hold",
      summary: "Fairly valued.",
      confidence: "medium",
    });

    expect(updateAsset).toHaveBeenCalledTimes(1);
    expect(String(result)).toMatch(/Saved AI Opinion for asset_id "asset-1": HOLD/);
  });

  it("refuses to overwrite when the workforce run is terminal", async () => {
    findQueueById.mockResolvedValueOnce({ id: "run-1", status: "timed_out" });

    const result = await call(
      {
        asset_id: "asset-1",
        verdict: "buy",
        summary: "Late verdict.",
        confidence: "high",
      },
      { configurable: { thread_id: "run-1" } },
    );

    expect(String(result)).toMatch(/workforce run is no longer active/);
    expect(updateAsset).not.toHaveBeenCalled();
  });

  it("returns an error string when the update throws", async () => {
    updateAsset.mockRejectedValueOnce(new Error("db down"));
    const result = await call({
      asset_id: "asset-1",
      verdict: "buy",
      summary: "x",
      confidence: "high",
    });
    expect(String(result)).toMatch(/\*\*Error:\*\* db down/);
  });

  it("describes hold as a real verdict, not an escape hatch", () => {
    expect(saveFundAiOpinion.description).toContain(
      'Do NOT use "hold" as a way to avoid committing',
    );
  });

  it("asks for honest confidence separate from a firm verdict", () => {
    expect(saveFundAiOpinion.description).toContain("Be HONEST about confidence");
  });
});
