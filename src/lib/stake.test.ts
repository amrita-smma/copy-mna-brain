import { describe, expect, it } from "vitest";
import { normalizeStake } from "./stake";

describe("normalizeStake", () => {
  it("clears empty / whitespace input to null", () => {
    expect(normalizeStake("")).toEqual({ value: null });
    expect(normalizeStake("   ")).toEqual({ value: null });
  });

  it("appends % to a bare number", () => {
    expect(normalizeStake("51")).toEqual({ value: "51%" });
  });

  it("keeps an already-formatted percentage", () => {
    expect(normalizeStake("51%")).toEqual({ value: "51%" });
    expect(normalizeStake(" 60 % ")).toEqual({ value: "60%" });
  });

  it("preserves meaningful decimals and drops trailing zeros", () => {
    expect(normalizeStake("33.33")).toEqual({ value: "33.33%" });
    expect(normalizeStake("51.50%")).toEqual({ value: "51.5%" });
    expect(normalizeStake("100.00")).toEqual({ value: "100%" });
  });

  it("strips thousands-style commas", () => {
    expect(normalizeStake("1,0%")).toEqual({ value: "10%" });
  });

  it("accepts the 0 and 100 bounds", () => {
    expect(normalizeStake("0")).toEqual({ value: "0%" });
    expect(normalizeStake("100%")).toEqual({ value: "100%" });
  });

  it("rejects non-numeric input", () => {
    expect(normalizeStake("half")).toEqual({
      error: "% Stake must be a percentage, e.g. 51%",
    });
    expect(normalizeStake("%")).toEqual({
      error: "% Stake must be a percentage, e.g. 51%",
    });
  });

  it("rejects values outside 0–100", () => {
    expect(normalizeStake("150")).toEqual({
      error: "% Stake must be between 0% and 100%",
    });
    expect(normalizeStake("-5")).toEqual({
      error: "% Stake must be between 0% and 100%",
    });
  });
});
