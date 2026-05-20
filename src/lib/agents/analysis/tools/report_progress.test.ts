import { describe, expect, it } from "vitest";
import { reportProgress } from "./report_progress";

describe("report_progress", () => {
  it("has the expected name and is no-op'd", async () => {
    expect(reportProgress.name).toBe("report_progress");
    const result = await reportProgress.invoke({
      items: [
        { label: "NovaSpec Materials", status: "done", detail: "CMP match" },
        { label: "Atlas Coatings", status: "checking" },
        { label: "SiC Korea", status: "pending" },
      ],
    });
    expect(result).toBe("ok");
  });

  it("rejects an unknown status enum value", async () => {
    await expect(
      reportProgress.invoke({
        items: [{ label: "x", status: "weird" }] as never,
      } as never),
    ).rejects.toBeDefined();
  });

  it("rejects items missing a label", async () => {
    await expect(
      reportProgress.invoke({
        items: [{ status: "pending" }] as never,
      } as never),
    ).rejects.toBeDefined();
  });

  it("rejects more than 20 items", async () => {
    const items = Array.from({ length: 21 }, (_, i) => ({
      label: `Item ${i}`,
      status: "pending" as const,
    }));
    await expect(reportProgress.invoke({ items })).rejects.toBeDefined();
  });
});
