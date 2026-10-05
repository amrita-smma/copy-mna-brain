import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getStalledDeals, listStages, createDb, createContainer, getActiveWorkspaceId } =
  vi.hoisted(() => ({
    getStalledDeals: vi.fn(),
    listStages: vi.fn(),
    createDb: vi.fn(),
    createContainer: vi.fn(),
    getActiveWorkspaceId: vi.fn(),
  }));

vi.mock("@/lib/server/db", () => ({ createDb }));
vi.mock("@/lib/workspace", () => ({ getActiveWorkspaceId }));
vi.mock("@/lib/services", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services")>();
  return { ...actual, createContainer };
});

import { analyzeStalledDeals } from "./analyze_stalled_deals";

function call(args: { stalled_weeks?: number; stage?: string } = {}) {
  return analyzeStalledDeals.invoke(args as never) as Promise<string>;
}

describe("analyze_stalled_deals", () => {
  beforeEach(() => {
    getStalledDeals.mockReset();
    listStages.mockReset().mockResolvedValue([]);
    createDb.mockReset().mockReturnValue({});
    getActiveWorkspaceId.mockReset().mockResolvedValue("workspace-a");
    createContainer.mockReset().mockReturnValue({
      stalledDealService: { getStalledDeals },
      pipelineStageService: { list: listStages },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("converts stalled_weeks to a day threshold when calling the service", async () => {
    getStalledDeals.mockResolvedValue({
      asOf: "2026-07-10T00:00:00.000Z",
      thresholdDays: 21,
      totalActive: 0,
      stalledCount: 0,
      deals: [],
    });

    await call({ stalled_weeks: 3 });

    expect(getStalledDeals).toHaveBeenCalledWith(
      expect.objectContaining({ thresholdDays: 21, stage: undefined }),
    );
  });

  it("reports when there are no active deals", async () => {
    getStalledDeals.mockResolvedValue({
      asOf: "2026-07-10T00:00:00.000Z",
      thresholdDays: 14,
      totalActive: 0,
      stalledCount: 0,
      deals: [],
    });

    const result = await call();

    expect(result).toContain("No active deals found");
  });

  it("renders a stalled table with timelines and a within-threshold section", async () => {
    getStalledDeals.mockResolvedValue({
      asOf: "2026-07-10T00:00:00.000Z",
      thresholdDays: 14,
      totalActive: 2,
      stalledCount: 1,
      deals: [
        {
          companyId: "c1",
          target: "Acme",
          projectName: "Alpha",
          segment: "Tech",
          geography: "USA",
          currentStage: "L2",
          status: "active",
          enteredStageAt: "2026-06-01T00:00:00.000Z",
          enteredStageBasis: "log",
          daysInStage: 39,
          isStalled: true,
          timeline: [
            { stage: "L1", fromStage: null, enteredAt: "2026-05-01T00:00:00.000Z", action: "PROMOTED_TO_L1" },
            { stage: "L2", fromStage: "L1", enteredAt: "2026-06-01T00:00:00.000Z", action: "PROMOTED_FROM_L1_TO_L2" },
          ],
        },
        {
          companyId: "c2",
          target: "Beta",
          projectName: null,
          segment: null,
          geography: null,
          currentStage: "L1",
          status: "active",
          enteredStageAt: "2026-07-05T00:00:00.000Z",
          enteredStageBasis: "created_at",
          daysInStage: 5,
          isStalled: false,
          timeline: [],
        },
      ],
    });

    const result = await call();

    expect(result).toContain("Stalled Deals Analysis");
    expect(result).toContain("**1 of 2**");
    // Stalled deal, its days-in-stage, and its timeline moves.
    expect(result).toContain("Acme");
    expect(result).toContain("39");
    expect(result).toContain("L1 → L2");
    // Within-threshold deal appears in the "Other active deals" section.
    expect(result).toContain("Other active deals");
    expect(result).toContain("Beta");
  });

  it("notes a since-creation timeline for a deal with no stage moves", async () => {
    getStalledDeals.mockResolvedValue({
      asOf: "2026-07-10T00:00:00.000Z",
      thresholdDays: 14,
      totalActive: 1,
      stalledCount: 1,
      deals: [
        {
          companyId: "c3",
          target: "Gamma",
          projectName: null,
          segment: null,
          geography: null,
          currentStage: "L0",
          status: "active",
          enteredStageAt: "2026-01-01T00:00:00.000Z",
          enteredStageBasis: "created_at",
          daysInStage: 190,
          isStalled: true,
          timeline: [],
        },
      ],
    });

    const result = await call();

    expect(result).toContain("added to pipeline at L0 (no stage changes since)");
  });

  it("returns a formatted error string when the service throws", async () => {
    getStalledDeals.mockRejectedValue(new Error("boom"));

    const result = await call();

    expect(result).toBe("**Error:** boom");
  });

  it("names stages by the workspace's codes and names, not their keys", async () => {
    listStages.mockResolvedValue([
      { key: "L1", code: "L1", name: "Preliminary Review", description: "", position: 1, deleted: false },
      { key: "stg-calls", code: "L1b", name: "Expert Calls", description: "", position: 2, deleted: false },
    ]);
    getStalledDeals.mockResolvedValue({
      asOf: "2026-07-10T00:00:00.000Z",
      thresholdDays: 14,
      totalActive: 1,
      stalledCount: 1,
      deals: [
        {
          companyId: "c1",
          target: "Acme",
          projectName: null,
          currentStage: "stg-calls",
          enteredStageAt: "2026-06-01T00:00:00.000Z",
          enteredStageBasis: "log",
          daysInStage: 39,
          isStalled: true,
          segment: null,
          geography: null,
          timeline: [
            { stage: "stg-calls", fromStage: "L1", enteredAt: "2026-06-01T00:00:00.000Z" },
          ],
        },
      ],
    });

    const result = await call({ stage: "stg-calls" });

    expect(result).toContain("stage L1b · Expert Calls");
    expect(result).toContain("L1 → L1b");
    expect(result).toContain("| Acme | L1b |");
    expect(result).not.toContain("stg-calls");
  });
});
