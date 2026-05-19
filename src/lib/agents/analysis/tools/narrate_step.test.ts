import { describe, expect, it } from "vitest";
import { narrateStep } from "./narrate_step";

describe("narrate_step", () => {
  it("has the expected name and is no-op'd", async () => {
    expect(narrateStep.name).toBe("narrate_step");
    const result = await narrateStep.invoke({
      title: "Querying companies",
      overview: "Searching for Korean semiconductor suppliers in L0.",
    });
    // Body returns "ok" — content lives in the call args, not the result.
    expect(result).toBe("ok");
  });

  it("rejects args missing a required field via Zod", async () => {
    await expect(
      narrateStep.invoke({ title: "t" } as never),
    ).rejects.toBeDefined();
  });

  it("accepts an optional plan: string[] arg", async () => {
    const result = await narrateStep.invoke({
      title: "Verifying L0 stage",
      overview: "Looking up Acme.",
      plan: ["Verify L0 stage", "Promote to L1", "Report outcome"],
    });
    expect(result).toBe("ok");
  });

  it("rejects a plan containing non-strings", async () => {
    await expect(
      narrateStep.invoke({
        title: "x",
        overview: "y",
        plan: [42] as never,
      } as never),
    ).rejects.toBeDefined();
  });
});
