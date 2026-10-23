import { describe, expect, it } from "vitest";
import type { ContactDealLink } from "@/lib/api/contactDeals";
import { buildBrainShortcuts } from "./shortcuts";

function deal(companyName: string, isDropped: boolean): ContactDealLink {
  return {
    companyId: companyName,
    companyName,
    role: "source",
    origin: "manual",
    stage: "L1",
    stageLabel: "L1 · Preliminary Review",
    isDropped,
    linkedAt: "2026-10-01T00:00:00.000Z",
  } as ContactDealLink;
}

describe("buildBrainShortcuts", () => {
  it("names an active and a dropped deal when the contact has both", () => {
    const pills = buildBrainShortcuts("Kenny", [deal("Nusantara", true), deal("Garuda", false)]);
    expect(pills.map((p) => p.label)).toEqual([
      "Summarise relationship",
      "Draft follow-up email",
      "Kenny's view on Garuda",
      "Why Kenny passed on Nusantara",
      "Ask something else",
    ]);
    expect(pills[2].question).toBe("What is Kenny's latest view on Garuda?");
  });

  it("falls back to deal-free questions without linked deals", () => {
    const pills = buildBrainShortcuts("Kenny", []);
    expect(pills[2].label).toBe("Open questions for Kenny");
    expect(pills[3].label).toBe("Intro paths via Kenny");
  });

  it("leaves the composer empty for 'Ask something else'", () => {
    expect(buildBrainShortcuts("Kenny", []).at(-1)).toEqual({
      key: "other",
      label: "Ask something else",
      question: "",
    });
  });

  it("uses a neutral name when the contact has none", () => {
    expect(buildBrainShortcuts("  ", [])[0].question).toBe(
      "Summarise our relationship with this contact",
    );
  });
});
