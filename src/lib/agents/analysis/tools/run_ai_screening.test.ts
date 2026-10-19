import { beforeEach, describe, expect, it, vi } from "vitest";

const { createDb, createContainer, getActiveWorkspaceId, processCompany, screenCompanyTracks } =
  vi.hoisted(() => ({
    createDb: vi.fn(),
    createContainer: vi.fn(),
    getActiveWorkspaceId: vi.fn(),
    processCompany: vi.fn(),
    screenCompanyTracks: vi.fn(),
  }));

vi.mock("@/lib/server/db", () => ({ createDb }));
vi.mock("@/lib/services/container", () => ({ createContainer }));
vi.mock("@/lib/workspace", () => ({ getActiveWorkspaceId }));

import { runAiScreening } from "./run_ai_screening";

describe("run_ai_screening (workforce tool)", () => {
  beforeEach(() => {
    createDb.mockReset().mockReturnValue({ db: true });
    getActiveWorkspaceId.mockReset().mockResolvedValue("ws-1");
    processCompany.mockReset();
    screenCompanyTracks.mockReset();
    createContainer.mockReset().mockReturnValue({
      pendingAutoScanService: { processCompany },
      aiScreeningService: { screenCompanyTracks },
    });
  });

  it("rejects a blank company_id without screening anything", async () => {
    const result = await runAiScreening.invoke({ company_id: "  ", mode: "tracks", force: true });

    expect(String(result)).toMatch(/company_id is required/);
    expect(createContainer).not.toHaveBeenCalled();
  });

  it("runs the Pending Confirmation scan in the run's workspace and reports its outcome", async () => {
    processCompany.mockResolvedValue({
      companyId: "c1",
      outcome: "promoted",
      verdict: "pass",
      screened: 3,
      steps: ["Screened 3 criteria across 1 track(s)", "Promoted to L0"],
    });

    const result = String(
      await runAiScreening.invoke(
        { company_id: "c1", mode: "pending_scan", force: true },
        { configurable: { triggered_by_user_id: "user-7" } },
      ),
    );

    expect(createContainer).toHaveBeenCalledWith({ db: true }, "ws-1");
    expect(processCompany).toHaveBeenCalledWith("c1", { force: true, triggeredByUserId: "user-7" });
    expect(result).toContain("outcome **promoted**");
    expect(result).toContain("verdict **pass**");
    expect(result).toContain("- Promoted to L0");
    expect(screenCompanyTracks).not.toHaveBeenCalled();
  });

  it("screens matched tracks only in tracks mode and lists each track's verdict", async () => {
    screenCompanyTracks.mockResolvedValue({
      screened: 4,
      tracks: [
        { trackId: "t1", title: "Healthcare", verdict: "pass" },
        { trackId: "t2", title: "Energy", verdict: "fail" },
      ],
    });

    const result = String(
      await runAiScreening.invoke({ company_id: "c1", mode: "tracks", force: false }),
    );

    expect(screenCompanyTracks).toHaveBeenCalledWith("c1", { force: false });
    expect(result).toContain("Screened 4 criteria across 2 track(s)");
    expect(result).toContain("- Healthcare: pass");
    expect(result).toContain("- Energy: fail");
    expect(processCompany).not.toHaveBeenCalled();
  });

  it("says so when no matched track has criteria", async () => {
    screenCompanyTracks.mockResolvedValue({ screened: 0, tracks: [] });

    const result = String(
      await runAiScreening.invoke({ company_id: "c1", mode: "tracks", force: true }),
    );

    expect(result).toMatch(/nothing was screened/);
  });

  it("returns the error as a string instead of throwing", async () => {
    processCompany.mockRejectedValue(new Error("db down"));

    const result = String(
      await runAiScreening.invoke({ company_id: "c1", mode: "pending_scan", force: false }),
    );

    expect(result).toBe("**Error:** db down");
  });
});
