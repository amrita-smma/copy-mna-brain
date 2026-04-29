import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("flags/next", () => ({
  flag: vi.fn((config) => {
    return async () => {
      const adapter = config.adapter;
      if (adapter && typeof adapter === "function") {
        const result = await adapter({ key: config.key });
        return result?.value ?? false;
      }
      return false;
    };
  }),
}));

vi.mock("@flags-sdk/vercel", () => ({
  vercelAdapter: vi.fn(() => {
    return async ({ key }: { key: string }) => {
      const flags = process.env.FLAGS;
      if (!flags) return { value: false };
      try {
        const parsed = JSON.parse(flags);
        return { value: Boolean(parsed[key]) };
      } catch {
        return { value: false };
      }
    };
  }),
}));

import { crmEnabled } from "./flags";

describe("Feature Flags", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("crmEnabled", () => {
    it("should return true when FLAGS contains CRM_ENABLED", async () => {
      process.env.FLAGS = JSON.stringify({ "CRM_ENABLED": true });
      const result = await crmEnabled();
      expect(result).toBe(true);
    });

    it("should return false when FLAGS is not set", async () => {
      delete process.env.FLAGS;
      const result = await crmEnabled();
      expect(result).toBe(false);
    });

    it("should return false when FLAGS contains CRM_ENABLED: false", async () => {
      process.env.FLAGS = JSON.stringify({ "CRM_ENABLED": false });
      const result = await crmEnabled();
      expect(result).toBe(false);
    });

    it("should return false when FLAGS does not contain the key", async () => {
      process.env.FLAGS = JSON.stringify({ "other-flag": true });
      const result = await crmEnabled();
      expect(result).toBe(false);
    });
  });
});
