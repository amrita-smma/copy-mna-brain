import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("flags/next", () => ({
  flag: vi.fn((config) => {
    return async () => {
      const adapter = config.adapter;
      if (adapter && typeof adapter === "function") {
        const result = await adapter({ key: config.key });
        return result?.value ?? false;
      }
      return config.defaultValue;
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

async function loadCompanyGraphEnabled() {
  vi.resetModules();
  const { companyGraphEnabled } = await import("./flags");
  return companyGraphEnabled;
}

describe("Feature Flags", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("companyGraphEnabled", () => {
    it("should return true when FLAGS contains COMPANY_GRAPH_ENABLED", async () => {
      process.env.FLAGS = JSON.stringify({ "COMPANY_GRAPH_ENABLED": true });
      const companyGraphEnabled = await loadCompanyGraphEnabled();
      const result = await companyGraphEnabled();
      expect(result).toBe(true);
    });

    it("should return false when FLAGS is not set", async () => {
      delete process.env.FLAGS;
      const companyGraphEnabled = await loadCompanyGraphEnabled();
      const result = await companyGraphEnabled();
      expect(result).toBe(false);
    });

    it("should return false when FLAGS contains COMPANY_GRAPH_ENABLED: false", async () => {
      process.env.FLAGS = JSON.stringify({ "COMPANY_GRAPH_ENABLED": false });
      const companyGraphEnabled = await loadCompanyGraphEnabled();
      const result = await companyGraphEnabled();
      expect(result).toBe(false);
    });

    it("should return false when FLAGS does not contain the key", async () => {
      process.env.FLAGS = JSON.stringify({ "other-flag": true });
      const companyGraphEnabled = await loadCompanyGraphEnabled();
      const result = await companyGraphEnabled();
      expect(result).toBe(false);
    });
  });
});
