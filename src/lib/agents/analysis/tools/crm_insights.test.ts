import { afterEach, describe, expect, it, vi } from "vitest";

const countFlaggedMock = vi.fn();
const countStaleEmployersMock = vi.fn();
const countSinceMock = vi.fn();

vi.mock("@/lib/server/db", () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock("@/lib/repositories", () => ({
  EmployerRepository: function EmployerRepository() {
    return { countFlagged: countFlaggedMock };
  },
  EmailRepository: function EmailRepository() {
    return {
      countStaleEmployers: countStaleEmployersMock,
      countSince: countSinceMock,
    };
  },
}));

vi.mock("@/lib/workspace", () => ({
  getActiveWorkspaceId: vi.fn(async () => "ws-active"),
}));

import { crmInsights } from "./crm_insights";

afterEach(() => vi.clearAllMocks());

describe("crmInsights", () => {
  it("renders the three portfolio metrics", async () => {
    countStaleEmployersMock.mockResolvedValue(7);
    countFlaggedMock.mockResolvedValue(2);
    countSinceMock.mockResolvedValue(15);

    const result = (await crmInsights.invoke({}, { configurable: { workspaceId: "ws-123" } })) as string;

    expect(result).toContain("## CRM Insights");
    expect(result).toContain("**Stale relationships:** 7");
    expect(result).toContain("**Flagged records:** 2");
    expect(result).toContain("**Emails today:** 15");
  });

  // Chat and background bot turns never put a workspaceId in `configurable`.
  it("scopes the counts to the active workspace when the config names none", async () => {
    countStaleEmployersMock.mockResolvedValue(1);
    countFlaggedMock.mockResolvedValue(1);
    countSinceMock.mockResolvedValue(1);

    const result = (await crmInsights.invoke({}, { configurable: { userId: "u1" } })) as string;

    expect(result).toContain("## CRM Insights");
    expect(countFlaggedMock).toHaveBeenCalledWith("ws-active");
    expect(countStaleEmployersMock.mock.calls[0][1]).toBe("ws-active");
    expect(countSinceMock.mock.calls[0][1]).toBe("ws-active");
  });

  it("queries stale employers against a 30-day threshold", async () => {
    countStaleEmployersMock.mockResolvedValue(0);
    countFlaggedMock.mockResolvedValue(0);
    countSinceMock.mockResolvedValue(0);

    await crmInsights.invoke({}, { configurable: { workspaceId: "ws-123" } });

    expect(countStaleEmployersMock).toHaveBeenCalledTimes(1);
    const thresholdArg = countStaleEmployersMock.mock.calls[0][0] as string;
    // The threshold is roughly 30 days before now.
    const ageMs = Date.now() - new Date(thresholdArg).getTime();
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    expect(ageDays).toBeGreaterThan(29);
    expect(ageDays).toBeLessThan(31);
  });

  it("returns an error string when a repository throws", async () => {
    countStaleEmployersMock.mockRejectedValue(new Error("db down"));
    countFlaggedMock.mockResolvedValue(0);
    countSinceMock.mockResolvedValue(0);

    const result = (await crmInsights.invoke({}, { configurable: { workspaceId: "ws-123" } })) as string;
    expect(result).toContain("**Error:** db down");
  });
});
