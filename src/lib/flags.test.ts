import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveFeatureOverride: vi.fn(),
}));

vi.mock("@/lib/features/overrides", () => ({
  resolveFeatureOverride: mocks.resolveFeatureOverride,
}));

import {
  companyGraphEnabled,
  fundManagementEnabled,
  insightsEnabled,
} from "./flags";

const FLAGS = [
  ["companyGraphEnabled", companyGraphEnabled, "COMPANY_GRAPH_ENABLED", false],
  ["fundManagementEnabled", fundManagementEnabled, "FUND_MANAGEMENT_ENABLED", false],
  ["insightsEnabled", insightsEnabled, "INSIGHTS_ENABLED", true],
] as const;

describe("Feature Flags", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mocks.resolveFeatureOverride.mockReset();
    mocks.resolveFeatureOverride.mockResolvedValue(undefined);
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe.each(FLAGS)("%s", (_name, flagFn, key, catalogDefault) => {
    it("returns true when the env var is 'true'", async () => {
      process.env[key] = "true";
      expect(await flagFn()).toBe(true);
    });

    it("returns false when the env var is 'false'", async () => {
      process.env[key] = "false";
      expect(await flagFn()).toBe(false);
    });

    it("falls back to the catalog default when the env var is unset", async () => {
      delete process.env[key];
      expect(await flagFn()).toBe(catalogDefault);
    });

    it("reads the env var at call time, not import time", async () => {
      process.env[key] = "false";
      expect(await flagFn()).toBe(false);
      process.env[key] = "true";
      expect(await flagFn()).toBe(true);
    });

    it("prefers a workspace override over the env var", async () => {
      process.env[key] = "false";
      mocks.resolveFeatureOverride.mockResolvedValue(true);
      expect(await flagFn()).toBe(true);
      expect(mocks.resolveFeatureOverride).toHaveBeenCalledWith(key);
    });

    it("lets a false override switch off an env-enabled flag", async () => {
      process.env[key] = "true";
      mocks.resolveFeatureOverride.mockResolvedValue(false);
      expect(await flagFn()).toBe(false);
    });
  });
});
