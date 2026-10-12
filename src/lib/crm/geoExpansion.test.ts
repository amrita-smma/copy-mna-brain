import { describe, expect, it } from "vitest";
import { expandGeography } from "./geoExpansion";

describe("expandGeography", () => {
  it("expands a country into the coverage regions that contain it", () => {
    const result = expandGeography("United States");

    expect(result.countryCode).toBe("US");
    // The deal's own country, its common spellings, and the region a banker
    // would actually have written in `coverage_region`.
    expect(result.exact).toContain("United States");
    expect(result.exact).toContain("USA");
    expect(result.exact).toContain("North America");
    // Umbrellas still cover it, but rank lower.
    expect(result.broad).toContain("Americas");
    expect(result.broad).toContain("Global");
    expect(result.exact).not.toContain("Global");
  });

  it("puts a country in every region that lists it (Mexico is North and Latin America)", () => {
    const result = expandGeography("Mexico");
    expect(result.exact).toEqual(
      expect.arrayContaining(["North America", "Latin America"]),
    );
    expect(result.broad).toContain("Americas");
  });

  it("tolerates alternative country spellings via country-to-iso", () => {
    expect(expandGeography("USA").exact).toContain("North America");
    expect(expandGeography("Korea").exact).toContain("East Asia");
  });

  it("expands a region to its sub-regions (a Greater China desk covers an APAC ask)", () => {
    const result = expandGeography("APAC");

    expect(result.region).toBe("Asia Pacific");
    expect(result.exact).toEqual(
      expect.arrayContaining([
        "Asia Pacific",
        "Southeast Asia",
        "Greater China",
      ]),
    );
    expect(result.broad).toContain("Global");
  });

  it("expands a sub-region upward, not downward", () => {
    const result = expandGeography("Southeast Asia");

    expect(result.exact).toContain("Southeast Asia");
    expect(result.exact).not.toContain("Greater China");
    expect(result.broad).toContain("Asia Pacific");
  });

  it("rolls North Africa up both ways — a MENA desk and an Africa desk cover Egypt", () => {
    const result = expandGeography("Egypt");

    expect(result.exact).toContain("North Africa");
    expect(result.broad).toEqual(expect.arrayContaining(["MENA", "Africa", "EMEA"]));
  });

  it("treats a global ask as matching only the global labels", () => {
    const result = expandGeography("global");
    expect(result.exact).toEqual(["Global", "Worldwide", "International"]);
    expect(result.broad).toEqual([]);
  });

  it("falls back to a literal match for input that names neither a country nor a region", () => {
    const result = expandGeography("Jakarta Selatan");
    expect(result.region).toBeNull();
    expect(result.countryCode).toBeNull();
    expect(result.exact).toEqual(["Jakarta Selatan"]);
    // Crucially NOT the global tokens: an unrecognised place must not quietly
    // match every globally-covering banker as though it were a geography hit.
    expect(result.broad).toEqual([]);
  });

  it("does not alias the US to bare \"America\" — matching is word-boundary anchored", () => {
    // "\yAmerica\y" also matches "Latin America", which would score a LatAm
    // desk on the coverage facet for a US deal.
    expect(expandGeography("United States").exact).not.toContain("America");
    // Including when the user typed the loose name themselves: country-to-iso
    // resolves "America" to US, and the curated alias list replaces the input.
    const loose = expandGeography("America");
    expect(loose.countryCode).toBe("US");
    expect(loose.exact).not.toContain("America");
    expect(loose.exact).toContain("United States");
  });

  it("keeps the asked-for spelling for a country with no alias list", () => {
    expect(expandGeography("Peru").exact).toContain("Peru");
  });

  it("returns nothing to match on for blank input", () => {
    expect(expandGeography("   ")).toEqual({
      exact: [],
      broad: [],
      region: null,
      countryCode: null,
    });
  });
});
