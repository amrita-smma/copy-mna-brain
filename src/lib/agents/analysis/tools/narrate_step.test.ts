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
});
