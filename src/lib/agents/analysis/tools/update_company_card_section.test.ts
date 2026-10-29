import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createDb, findByCompanyId, updateByCompanyId, CompanyAnalysisRepository } =
  vi.hoisted(() => {
    const findByCompanyId = vi.fn();
    const updateByCompanyId = vi.fn();
    class CompanyAnalysisRepository {
      findByCompanyId = findByCompanyId;
      updateByCompanyId = updateByCompanyId;
    }
    return {
      createDb: vi.fn(),
      findByCompanyId,
      updateByCompanyId,
      CompanyAnalysisRepository,
    };
  });

vi.mock("@/lib/server/db", () => ({ createDb }));
vi.mock("@/lib/workspace", () => ({ getActiveWorkspaceId: vi.fn().mockResolvedValue("ws-1") }));
const liveMocks = vi.hoisted(() => ({ publishLiveEvent: vi.fn() }));
vi.mock("@/lib/server/liveEvents", () => ({ publishLiveEvent: liveMocks.publishLiveEvent }));

vi.mock("@/lib/repositories", () => ({ CompanyAnalysisRepository }));

import { updateCompanyCardSection } from "./update_company_card_section";

function call(args: { company_id: string; section: string; content: string }) {
  return updateCompanyCardSection.invoke(args as never);
}

describe("update_company_card_section", () => {
  beforeEach(() => {
    createDb.mockReset().mockReturnValue({});
    findByCompanyId
      .mockReset()
      .mockResolvedValue({ id: "analysis-1", company_id: "co-1" });
    updateByCompanyId
      .mockReset()
      .mockResolvedValue({ id: "analysis-1", company_id: "co-1" });
    liveMocks.publishLiveEvent.mockReset().mockResolvedValue(undefined);
  });

  it("announces the card on the company-card topic after the write, so the slide that asked re-reads it", async () => {
    await call({ company_id: "co-1", section: "key_takeaways", content: "- point" });

    expect(liveMocks.publishLiveEvent).toHaveBeenCalledWith("ws-1", "company-card", ["co-1"]);
    expect(liveMocks.publishLiveEvent.mock.invocationCallOrder[0]).toBeGreaterThan(
      updateByCompanyId.mock.invocationCallOrder[0],
    );
  });

  it("announces nothing when there is no card to edit", async () => {
    findByCompanyId.mockResolvedValueOnce(null);
    await call({ company_id: "co-1", section: "key_takeaways", content: "- point" });
    expect(liveMocks.publishLiveEvent).not.toHaveBeenCalled();
  });

  afterEach(() => vi.restoreAllMocks());

  it("rejects a blank company_id without touching the repository", async () => {
    const result = await call({
      company_id: "  ",
      section: "business_overview",
      content: "x",
    });
    expect(String(result)).toMatch(/company_id is required/);
    expect(findByCompanyId).not.toHaveBeenCalled();
  });

  it("rejects blank content", async () => {
    const result = await call({
      company_id: "co-1",
      section: "business_overview",
      content: "   ",
    });
    expect(String(result)).toMatch(/content is required/);
    expect(updateByCompanyId).not.toHaveBeenCalled();
  });

  it("errors when no card exists yet for the company", async () => {
    findByCompanyId.mockResolvedValueOnce(null);
    const result = await call({
      company_id: "co-1",
      section: "investment_risks",
      content: "- risk",
    });
    expect(String(result)).toMatch(/No AI Company Card exists/);
    expect(updateByCompanyId).not.toHaveBeenCalled();
  });

  it("overwrites only the named section and reports success", async () => {
    const result = await call({
      company_id: "co-1",
      section: "investment_highlights",
      content: "- **Market Position**: leader",
    });

    expect(updateByCompanyId).toHaveBeenCalledTimes(1);
    const [id, updates] = updateByCompanyId.mock.calls[0];
    expect(id).toBe("co-1");
    expect(updates).toMatchObject({
      investment_highlights: "- **Market Position**: leader",
      status: "completed",
      error_message: null,
    });
    // No other section field is written.
    expect(Object.keys(updates)).toEqual(
      expect.arrayContaining(["investment_highlights", "status", "error_message"]),
    );
    expect(updates).not.toHaveProperty("business_overview");
    expect(String(result)).toMatch(/Updated the/);
  });

  it("carries the card's house style so an inline edit cannot reintroduce the banned bullets", () => {
    const description = updateCompanyCardSection.description;

    expect(description).toContain("Neutral, factual investment-analyst register");
    expect(description).toContain("3-4 points per section");
    expect(description).toContain(
      'do NOT include a "Data Gaps" bullet or any variant',
    );
    expect(description).toContain("generic end-market cyclicality bullet");
    expect(description).toContain(
      "ONLY when it is materially above the industry norm",
    );
  });

  it("returns an error string when the update throws", async () => {
    updateByCompanyId.mockRejectedValueOnce(new Error("db down"));
    const result = await call({
      company_id: "co-1",
      section: "diligence_priorities",
      content: "1. question?",
    });
    expect(String(result)).toMatch(/\*\*Error:\*\* db down/);
  });
});
