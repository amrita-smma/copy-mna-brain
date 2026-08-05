import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  createDb,
  completeAiOpinionIfProcessing,
  findById,
  findQueueById,
  CompanyRepository,
  AiWorkforceQueueRepository,
} = vi.hoisted(() => {
  const completeAiOpinionIfProcessing = vi.fn();
  const findById = vi.fn();
  const findQueueById = vi.fn();
  class CompanyRepository {
    completeAiOpinionIfProcessing = completeAiOpinionIfProcessing;
    findById = findById;
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
    findQueueById,
    CompanyRepository,
    AiWorkforceQueueRepository,
  };
});

vi.mock("@/lib/server/db", () => ({ createDb }));

vi.mock("@/lib/workspace", () => ({
  getActiveWorkspaceId: vi.fn(async () => "ws-1"),
}));

vi.mock("@/lib/repositories", () => ({
  CompanyRepository,
  AiWorkforceQueueRepository,
}));

import { saveAiOpinion } from "./save_ai_opinion";

function call(
  args: { company_id: string; verdict: string; summary: string },
  config?: { configurable?: { thread_id?: string } },
) {
  return saveAiOpinion.invoke(args as never, config as never);
}

describe("save_ai_opinion", () => {
  beforeEach(() => {
    createDb.mockReset().mockReturnValue({});
    completeAiOpinionIfProcessing.mockReset().mockResolvedValue({ id: "co-1" });
    findById.mockReset().mockResolvedValue({ id: "co-1" });
    findQueueById.mockReset().mockResolvedValue({ id: "run-1", status: "running" });
  });

  afterEach(() => vi.restoreAllMocks());

  it("rejects a blank company_id without touching the repository", async () => {
    const result = await call({ company_id: " ", verdict: "pass", summary: "x" });
    expect(String(result)).toMatch(/company_id is required/);
    expect(completeAiOpinionIfProcessing).not.toHaveBeenCalled();
  });

  it("rejects a blank summary without touching the repository", async () => {
    const result = await call({
      company_id: "co-1",
      verdict: "fail",
      summary: "   ",
    });
    expect(String(result)).toMatch(/summary is required/);
    expect(completeAiOpinionIfProcessing).not.toHaveBeenCalled();
  });

  it("writes the verdict, summary, and completed status onto the company row", async () => {
    const result = await call({
      company_id: "co-1",
      verdict: "pass",
      summary: "Strong fundamentals and margin trajectory.",
    });

    expect(completeAiOpinionIfProcessing).toHaveBeenCalledTimes(1);
    const [id, updates] = completeAiOpinionIfProcessing.mock.calls[0];
    expect(id).toBe("co-1");
    expect(updates).toMatchObject({
      ai_opinion_verdict: "pass",
      ai_opinion_summary: "Strong fundamentals and margin trajectory.",
      ai_opinion_status: "completed",
    });
    expect(String(result)).toMatch(/Saved AI Opinion .* PASS/);
  });

  it("clamps the summary to 50 words before persisting", async () => {
    const summary = Array.from({ length: 60 }, (_, i) => `w${i}`).join(" ");
    await call({ company_id: "co-1", verdict: "tentative", summary });

    const [, updates] = completeAiOpinionIfProcessing.mock.calls[0];
    const words = String(updates.ai_opinion_summary).split(/\s+/);
    expect(words).toHaveLength(50);
    expect(String(updates.ai_opinion_summary)).toMatch(/…$/);
  });

  it("errors when no company matches the id", async () => {
    completeAiOpinionIfProcessing.mockResolvedValueOnce(undefined);
    findById.mockResolvedValueOnce(undefined);
    const result = await call({
      company_id: "missing",
      verdict: "fail",
      summary: "x",
    });
    expect(String(result)).toMatch(/No company found for company_id "missing"/);
  });

  it("skips the write when the company is no longer processing", async () => {
    completeAiOpinionIfProcessing.mockResolvedValueOnce(undefined);
    const result = await call({
      company_id: "co-1",
      verdict: "pass",
      summary: "x",
    });
    expect(String(result)).toMatch(/no longer processing/);
  });

  it("skips the write when the owning workforce run is already terminal", async () => {
    findQueueById.mockResolvedValueOnce({ id: "run-1", status: "failed" });
    const result = await call(
      { company_id: "co-1", verdict: "pass", summary: "x" },
      { configurable: { thread_id: "run-1" } },
    );
    expect(String(result)).toMatch(/no longer active/);
    expect(completeAiOpinionIfProcessing).not.toHaveBeenCalled();
  });

  it("returns an error string when the update throws", async () => {
    completeAiOpinionIfProcessing.mockRejectedValueOnce(new Error("db down"));
    const result = await call({
      company_id: "co-1",
      verdict: "pass",
      summary: "x",
    });
    expect(String(result)).toMatch(/\*\*Error:\*\* db down/);
  });

  it("keeps the verdict unbiased by design: description forbids reading the drop reason up front and over-weighting tracks", () => {
    expect(saveAiOpinion.description).toContain(
      "Do not read any human-recorded drop reason before deciding",
    );
    expect(saveAiOpinion.description).toContain(
      "Matching no track is never a reason to \"fail\"",
    );
    expect(saveAiOpinion.description).toContain(
      "track fit should carry little weight",
    );
  });
});
