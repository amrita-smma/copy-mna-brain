import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createDb,
  completeAiOpinionIfProcessing,
  findById,
  findByFundAssetId,
  findQueueById,
  FundAssetRepository,
  FundAssetValuationRepository,
  AiWorkforceQueueRepository,
} = vi.hoisted(() => {
  const completeAiOpinionIfProcessing = vi.fn();
  const findById = vi.fn();
  const findByFundAssetId = vi.fn();
  const findQueueById = vi.fn();
  class FundAssetRepository {
    completeAiOpinionIfProcessing = completeAiOpinionIfProcessing;
    findById = findById;
  }
  class FundAssetValuationRepository {
    findByFundAssetId = findByFundAssetId;
  }
  class AiWorkforceQueueRepository {
    findById = findQueueById;
    static isTerminal(status: string) {
      return ["succeeded", "failed", "rejected", "timed_out"].includes(status);
    }
  }
  return {
    createDb: vi.fn(),
    completeAiOpinionIfProcessing,
    findById,
    findByFundAssetId,
    findQueueById,
    FundAssetRepository,
    FundAssetValuationRepository,
    AiWorkforceQueueRepository,
  };
});

vi.mock("@/lib/server/db", () => ({ createDb }));

vi.mock("@/lib/workspace", () => ({
  getActiveWorkspaceId: vi.fn(async () => "ws-1"),
}));

vi.mock("@/lib/repositories", () => ({
  FundAssetRepository,
  FundAssetValuationRepository,
  AiWorkforceQueueRepository,
}));

import { saveFundAiOpinion } from "./save_fund_ai_opinion";

const RICH_ASSET = {
  id: "asset-1",
  sector: "Robotics",
  country: "Singapore",
  fmv_amount: 800_000,
  gross_moic: 1.6,
  gross_irr: 0.12,
  invested_capital_amount: 500_000,
  investment_description: "Series B lead.",
};

const RICH_VALUATIONS = [
  { as_of_date: "2024-12-31" },
  { as_of_date: "2024-06-30" },
  { as_of_date: "2023-12-31" },
];

function call(
  args: {
    fund_asset_id: string;
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
    completeAiOpinionIfProcessing.mockReset().mockResolvedValue({ id: "asset-1" });
    findById.mockReset().mockResolvedValue(RICH_ASSET);
    findByFundAssetId.mockReset().mockResolvedValue(RICH_VALUATIONS);
    findQueueById.mockReset().mockResolvedValue({ id: "run-1", status: "running" });
  });

  afterEach(() => vi.restoreAllMocks());

  it("rejects a blank fund_asset_id without touching the repository", async () => {
    const result = await call({
      fund_asset_id: " ",
      verdict: "buy",
      summary: "x",
      confidence: "high",
    });
    expect(String(result)).toMatch(/fund_asset_id is required/);
    expect(completeAiOpinionIfProcessing).not.toHaveBeenCalled();
  });

  it("rejects a blank summary without touching the repository", async () => {
    const result = await call({
      fund_asset_id: "asset-1",
      verdict: "sell",
      summary: "   ",
      confidence: "medium",
    });
    expect(String(result)).toMatch(/summary is required/);
    expect(completeAiOpinionIfProcessing).not.toHaveBeenCalled();
  });

  it("rejects an invalid verdict at the schema layer without touching the repository", async () => {
    // The zod schema's enum() already restricts verdict to buy/hold/sell, so
    // an out-of-enum value never reaches the handler — LangChain's tool
    // wrapper throws during input validation instead.
    await expect(
      call({
        fund_asset_id: "asset-1",
        verdict: "pass" as never,
        summary: "x",
        confidence: "high",
      }),
    ).rejects.toThrow(/Received tool input did not match expected schema/);
    expect(completeAiOpinionIfProcessing).not.toHaveBeenCalled();
  });

  it("writes the verdict, summary, confidence, and completed status onto the fund asset row", async () => {
    const result = await call({
      fund_asset_id: "asset-1",
      verdict: "buy",
      summary: "Strong growth trajectory and healthy MOIC.",
      confidence: "high",
    });

    expect(completeAiOpinionIfProcessing).toHaveBeenCalledTimes(1);
    const [id, updates] = completeAiOpinionIfProcessing.mock.calls[0];
    expect(id).toBe("asset-1");
    expect(updates).toMatchObject({
      ai_opinion_verdict: "buy",
      ai_opinion_summary: "Strong growth trajectory and healthy MOIC.",
      ai_opinion_confidence: "high",
      ai_opinion_status: "completed",
    });
    expect(updates.ai_opinion_data_gaps).toBeNull();
    expect(String(result)).toMatch(/Saved AI Opinion .* BUY/);
  });

  it("clamps agent confidence down when recorded data is sparse", async () => {
    findById.mockResolvedValueOnce({
      ...RICH_ASSET,
      sector: null,
      country: null,
      fmv_amount: null,
      gross_moic: null,
      gross_irr: null,
      invested_capital_amount: null,
      investment_description: null,
    });
    findByFundAssetId.mockResolvedValueOnce([]);

    await call({
      fund_asset_id: "asset-1",
      verdict: "buy",
      summary: "Buy on sector narrative alone.",
      confidence: "high",
    });

    const [, updates] = completeAiOpinionIfProcessing.mock.calls[0];
    expect(updates.ai_opinion_confidence).toBe("low");
    expect(String(updates.ai_opinion_data_gaps)).toContain("no valuation history");
  });

  it("clamps the summary to 50 words before persisting", async () => {
    const summary = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
    await call({
      fund_asset_id: "asset-1",
      verdict: "hold",
      summary,
      confidence: "medium",
    });

    const [, updates] = completeAiOpinionIfProcessing.mock.calls[0];
    const words = String(updates.ai_opinion_summary).split(/\s+/);
    expect(words).toHaveLength(50);
    expect(String(updates.ai_opinion_summary)).toMatch(/…$/);
  });

  it("errors when no fund asset matches the id", async () => {
    findById.mockResolvedValueOnce(undefined);
    const result = await call({
      fund_asset_id: "missing",
      verdict: "sell",
      summary: "x",
      confidence: "low",
    });
    expect(String(result)).toMatch(/No fund asset found for fund_asset_id "missing"/);
    expect(completeAiOpinionIfProcessing).not.toHaveBeenCalled();
  });

  it("skips the write when the holding is no longer processing", async () => {
    completeAiOpinionIfProcessing.mockResolvedValueOnce(undefined);
    const result = await call({
      fund_asset_id: "asset-1",
      verdict: "buy",
      summary: "x",
      confidence: "high",
    });
    expect(String(result)).toMatch(/no longer processing/);
  });

  it("skips the write when the owning workforce run is already terminal", async () => {
    findQueueById.mockResolvedValueOnce({ id: "run-1", status: "failed" });
    const result = await call(
      {
        fund_asset_id: "asset-1",
        verdict: "buy",
        summary: "x",
        confidence: "high",
      },
      { configurable: { thread_id: "run-1" } },
    );
    expect(String(result)).toMatch(/no longer active/);
    expect(completeAiOpinionIfProcessing).not.toHaveBeenCalled();
  });

  it("returns an error string when the update throws", async () => {
    completeAiOpinionIfProcessing.mockRejectedValueOnce(new Error("db down"));
    const result = await call({
      fund_asset_id: "asset-1",
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
