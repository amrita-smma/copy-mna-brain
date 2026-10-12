import { describe, expect, it } from "vitest";
import {
  expandDealType,
  expandDepartment,
  expandSeniority,
} from "./dealExpertise";

describe("expandDealType", () => {
  it("maps an LBO to the desks that actually finance one", () => {
    const result = expandDealType("LBO");

    expect(result.recognized).toBe(true);
    expect(result.departments).toEqual(
      expect.arrayContaining([
        "Leveraged Finance",
        "Debt Capital Markets",
        "Financial Sponsors",
      ]),
    );
    expect(result.keywords).toEqual(
      expect.arrayContaining(["LBO", "leveraged", "buyout", "sponsor"]),
    );
  });

  it("reads the mandate out of a sentence, not just a bare acronym", () => {
    const result = expandDealType("we're looking to take the company private via an LBO");
    expect(result.departments).toContain("Leveraged Finance");
  });

  it("matches a trigger as a word prefix so plurals and tenses still hit", () => {
    expect(expandDealType("refinancing").departments).toContain(
      "Debt Capital Markets",
    );
    expect(expandDealType("mergers").departments).toContain("M&A");
  });

  it("unions every playbook entry a description touches", () => {
    const result = expandDealType("sell-side carve-out with a pre-IPO angle");
    expect(result.departments).toEqual(
      expect.arrayContaining(["M&A", "Equity Capital Markets"]),
    );
  });

  it("does not match a trigger buried inside another word", () => {
    // "boned" contains "bond" nowhere near a word start; "carbond" would be a
    // false hit if triggers were plain substrings.
    expect(expandDealType("carbonded steel supplier").recognized).toBe(false);
  });

  it("passes unrecognised input through literally rather than dropping it", () => {
    const result = expandDealType("Shariah compliance advisory");

    expect(result.recognized).toBe(false);
    expect(result.departments).toEqual(["Shariah compliance advisory"]);
    expect(result.keywords).toEqual(["Shariah compliance advisory"]);
  });

  it("returns nothing to match on for blank input", () => {
    expect(expandDealType("  ")).toEqual({
      departments: [],
      keywords: [],
      recognized: false,
    });
  });
});

describe("expandDepartment", () => {
  it("treats a desk abbreviation and its full name as the same desk", () => {
    const result = expandDepartment("DCM");
    expect(result).toEqual(expect.arrayContaining(["DCM", "Debt Capital Markets"]));
  });

  it("keeps the asked-for desk first", () => {
    expect(expandDepartment("Debt Capital Markets")[0]).toBe("Debt Capital Markets");
  });

  it("leaves a desk with no synonym entry alone", () => {
    expect(expandDepartment("Research")).toEqual(["Research"]);
  });

  it("expands to spellings of the SAME desk, not to the whole mandate playbook", () => {
    // A "who is on the DCM desk" ask must not rank Private Credit and
    // Structured Finance equally with DCM — that fan-out is deal_type's job.
    const result = expandDepartment("DCM");
    expect(result).not.toContain("Private Credit");
    expect(result).not.toContain("Structured Finance");
    expect(expandDealType("DCM").departments).toContain("Private Credit");
  });
});

describe("expandSeniority", () => {
  it("expands shorthand into the written-out band", () => {
    expect(expandSeniority("MD")).toEqual(
      expect.arrayContaining(["MD", "Managing Director"]),
    );
  });

  it("maps a vague band onto the titles that satisfy it", () => {
    expect(expandSeniority("senior")).toEqual(
      expect.arrayContaining(["Managing Director", "Partner"]),
    );
  });

  it("passes an unknown band through", () => {
    expect(expandSeniority("Chief Dealmaker")).toEqual(["Chief Dealmaker"]);
  });
});
