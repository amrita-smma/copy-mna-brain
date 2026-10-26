import { describe, it, expect } from "vitest";
import { computeFunnelStages, parseStageLabel, summariseFunnel } from "./funnel";

describe("computeFunnelStages", () => {
  it("returns empty array for empty breakdown", () => {
    expect(computeFunnelStages([])).toEqual([]);
  });

  it("calculates suffix sums correctly across stages", () => {
    const input = [
      { stageKey: "lead", label: "L0 · Lead", count: 10, currentCount: 0 },
      { stageKey: "screening", label: "L1 · Screening", count: 5, currentCount: 0 },
      { stageKey: "diligence", label: "L2 · Diligence", count: 3, currentCount: 0 },
      { stageKey: "closing", label: "L3 · Closing", count: 2, currentCount: 0 },
    ];

    // Suffix sums: 10+5+3+2, 5+3+2, 3+2, 2.
    const result = computeFunnelStages(input);

    expect(result.map((s) => s.funnelCount)).toEqual([20, 10, 5, 2]);
    expect(result.map((s) => s.conversionFromPrev)).toEqual(["—", "50%", "50%", "40%"]);
    expect(result.map((s) => s.percentageOfTotal)).toEqual([100, 50, 25, 10]);
  });

  it("shows '—' for step conversion when previous is 0", () => {
    const input = [
      { stageKey: "lead", label: "L0 · Lead", count: 0, currentCount: 0 },
      { stageKey: "screening", label: "L1 · Screening", count: 0, currentCount: 0 },
      { stageKey: "diligence", label: "L2 · Diligence", count: 0, currentCount: 0 },
    ];

    const result = computeFunnelStages(input);

    expect(result.map((s) => s.funnelCount)).toEqual([0, 0, 0]);
    expect(result.map((s) => s.conversionFromPrev)).toEqual(["—", "—", "—"]);
    expect(result.map((s) => s.percentageOfTotal)).toEqual([0, 0, 0]);
  });

  it("handles when only a later stage has deals", () => {
    const input = [
      { stageKey: "lead", label: "L0 · Lead", count: 0, currentCount: 0 },
      { stageKey: "screening", label: "L1 · Screening", count: 4, currentCount: 0 },
      { stageKey: "closing", label: "L2 · Closing", count: 0, currentCount: 0 },
    ];

    const result = computeFunnelStages(input);

    expect(result.map((s) => s.funnelCount)).toEqual([4, 4, 0]);
    expect(result.map((s) => s.conversionFromPrev)).toEqual(["—", "100%", "0%"]);
    expect(result.map((s) => s.percentageOfTotal)).toEqual([100, 100, 0]);
  });
});

describe("parseStageLabel", () => {
  it("splits a level-prefixed label", () => {
    expect(parseStageLabel("L3 · Due Diligence")).toEqual({ level: "L3", name: "Due Diligence" });
  });

  it("returns no level for a pre-pipeline label", () => {
    expect(parseStageLabel("Pending Confirmation")).toEqual({
      level: null,
      name: "Pending Confirmation",
    });
  });
});

describe("summariseFunnel", () => {
  const breakdown = [
    { stageKey: "l0", label: "L0 · Sourcing", count: 1, currentCount: 1 },
    { stageKey: "l1", label: "L1 · Preliminary Review", count: 1, currentCount: 0 },
    { stageKey: "l2", label: "L2 · Deep Dive", count: 0, currentCount: 0 },
    { stageKey: "l3", label: "L3 · Closing", count: 2, currentCount: 2 },
  ];

  it("returns no bullets when nothing was brought", () => {
    expect(summariseFunnel([], "Sally")).toEqual([]);
    expect(
      summariseFunnel(
        computeFunnelStages([{ stageKey: "l0", label: "L0 · Sourcing", count: 0, currentCount: 0 }]),
        "Sally",
      ),
    ).toEqual([]);
  });

  it("states deals brought, end-to-end and the biggest drop-off", () => {
    // Funnel counts: 4 → 3 → 2 → 2.
    expect(summariseFunnel(computeFunnelStages(breakdown), "Sally")).toEqual([
      "Sally brought 4 deals; 2 reached Closing (50% end-to-end).",
      "Biggest drop-off is L1 → L2 (Deep Dive), converting only 67%.",
    ]);
  });

  it("says involved in, not brought, in involved mode", () => {
    expect(summariseFunnel(computeFunnelStages(breakdown), "Sally", "involved")[0]).toBe(
      "Sally was involved in 4 deals; 2 reached Closing (50% end-to-end).",
    );
  });

  it("counts live deals in the two stages before the last, by their labels", () => {
    const six = computeFunnelStages([
      { stageKey: "l0", label: "L0 · Company Sourcing", count: 40, currentCount: 30 },
      { stageKey: "l1", label: "L1 · Preliminary Review", count: 6, currentCount: 4 },
      { stageKey: "l2", label: "L2 · Deep Dive", count: 4, currentCount: 3 },
      { stageKey: "l3", label: "L3 · Due Diligence", count: 4, currentCount: 3 },
      { stageKey: "l4", label: "L4 · IC Review", count: 4, currentCount: 2 },
      { stageKey: "l5", label: "L5 · Closing", count: 4, currentCount: 4 },
    ]);
    expect(summariseFunnel(six, "Kenny")).toEqual([
      "Kenny brought 62 deals; 4 reached Closing (6% end-to-end).",
      "Biggest drop-off is L0 → L1 (Preliminary Review), converting only 35%.",
      "5 deals are in Due Diligence or IC Review — prioritise follow-ups there.",
    ]);
  });

  it("skips the follow-up bullet when no live deal sits in those stages", () => {
    const six = computeFunnelStages([
      { stageKey: "l0", label: "L0 · Sourcing", count: 1, currentCount: 0 },
      { stageKey: "l1", label: "L1 · Review", count: 0, currentCount: 0 },
      { stageKey: "l2", label: "L2 · Diligence", count: 0, currentCount: 0 },
      { stageKey: "l3", label: "L3 · IC", count: 1, currentCount: 0 },
      { stageKey: "l4", label: "L4 · Closing", count: 0, currentCount: 0 },
    ]);
    expect(summariseFunnel(six, "Sally")).toHaveLength(2);
  });

  it("omits the drop-off bullet when no stage loses deals", () => {
    const flat = computeFunnelStages([
      { stageKey: "l0", label: "L0 · Sourcing", count: 0, currentCount: 0 },
      { stageKey: "l1", label: "L1 · Review", count: 1, currentCount: 1 },
    ]);
    expect(summariseFunnel(flat, "Sally")).toEqual([
      "Sally brought 1 deal; 1 reached Review (100% end-to-end).",
    ]);
  });

  it("says none got that far when a stage converts nothing", () => {
    const stalled = computeFunnelStages([
      { stageKey: "l0", label: "L0 · Sourcing", count: 1, currentCount: 1 },
      { stageKey: "l1", label: "L1 · Review", count: 0, currentCount: 0 },
    ]);
    expect(summariseFunnel(stalled, "Sally")[1]).toBe(
      "Biggest drop-off is L0 → L1 (Review): none got that far.",
    );
  });

  it("names stages without a level by their label", () => {
    const pre = computeFunnelStages([
      { stageKey: "pending", label: "Pending Confirmation", count: 1, currentCount: 1 },
      { stageKey: "l0", label: "L0 · Sourcing", count: 1, currentCount: 1 },
    ]);
    expect(summariseFunnel(pre, "Sally")[1]).toBe(
      "Biggest drop-off is Pending Confirmation → Sourcing, converting only 50%.",
    );
  });
});
