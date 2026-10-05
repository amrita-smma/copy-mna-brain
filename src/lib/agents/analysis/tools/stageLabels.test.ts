import { describe, expect, it, vi } from "vitest";

const { list } = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/lib/repositories/pipelineStageRepository", () => ({
  PipelineStageRepository: class {
    list = list;
  },
}));

import { loadStageLabeler } from "./stageLabels";

describe("loadStageLabeler", () => {
  it("names workspace stages by code and name and passes buckets through", async () => {
    list.mockResolvedValue([
      { key: "L3", code: "L3", name: "Due Diligence", description: "", position: 3, deleted_at: null },
      { key: "stg-post", code: "L6", name: "Post-Close", description: "", position: 6, deleted_at: null },
    ]);
    const label = await loadStageLabeler({} as never, "ws-a");
    expect(label("stg-post")).toBe("L6 · Post-Close");
    expect(label("L3")).toBe("L3 · Due Diligence");
    expect(label("unreviewed")).toBe("unreviewed");
    expect(label(null)).toBeNull();
  });

  it("falls back to the raw key when the stages cannot be read", async () => {
    list.mockImplementation(async () => {
      throw new Error("db down");
    });
    const label = await loadStageLabeler({} as never, "ws-a");
    expect(label("stg-post")).toBe("stg-post");
  });
});
