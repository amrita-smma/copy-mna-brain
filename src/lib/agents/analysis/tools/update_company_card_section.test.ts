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
