import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST, DELETE } from "./route";
import { EntityNotFoundError, InvalidMasterDataError, WorkspaceMismatchError } from "@/lib/services";

vi.mock("@/lib/server/db", () => ({
  createDb: vi.fn().mockReturnValue({}),
}));

vi.mock("@/lib/workspace", () => ({
  getActiveWorkspaceId: vi.fn().mockResolvedValue("ws-test"),
}));

const mockDispatch = vi.fn();
const mockClear = vi.fn();

vi.mock("@/lib/services", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/services")>();
  return {
    ...actual,
    createContainer: vi.fn().mockReturnValue({
      fundAiOpinionService: {
        dispatch: (...args: unknown[]) => mockDispatch(...args),
        clear: (...args: unknown[]) => mockClear(...args),
      },
    }),
  };
});

describe("API /api/fund-ledger/ai-opinion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST", () => {
    it("dispatches AI opinion for asset and ignores any caller-supplied internal/audit IDs", async () => {
      mockDispatch.mockResolvedValue({ runId: "run-123" });
      const req = new NextRequest("http://localhost/api/fund-ledger/ai-opinion", {
        method: "POST",
        body: JSON.stringify({
          asset_id: "asset-1",
          triggered_by_user_id: "malicious-user-id",
          userId: "malicious-user-id-2",
          created_by: "attacker",
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: { runId: "run-123" } });
      // Verified: caller-supplied user IDs in payload are NOT passed to service
      expect(mockDispatch).toHaveBeenCalledWith("asset-1", null);
    });

    it("accepts fund_asset_id legacy alias", async () => {
      mockDispatch.mockResolvedValue({ runId: "run-123" });
      const req = new NextRequest("http://localhost/api/fund-ledger/ai-opinion", {
        method: "POST",
        body: JSON.stringify({
          fund_asset_id: "asset-1",
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(mockDispatch).toHaveBeenCalledWith("asset-1", null);
    });

    it("rejects request missing asset_id with 422", async () => {
      const req = new NextRequest("http://localhost/api/fund-ledger/ai-opinion", {
        method: "POST",
        body: JSON.stringify({}),
      });

      const res = await POST(req);
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain("Missing required field: asset_id");
    });

    it("maps EntityNotFoundError to 404", async () => {
      mockDispatch.mockRejectedValue(new EntityNotFoundError("Asset not found"));
      const req = new NextRequest("http://localhost/api/fund-ledger/ai-opinion", {
        method: "POST",
        body: JSON.stringify({ asset_id: "nonexistent" }),
      });

      const res = await POST(req);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toContain("Asset not found");
    });

    it("maps WorkspaceMismatchError to 403", async () => {
      mockDispatch.mockRejectedValue(new WorkspaceMismatchError("Forbidden workspace"));
      const req = new NextRequest("http://localhost/api/fund-ledger/ai-opinion", {
        method: "POST",
        body: JSON.stringify({ asset_id: "asset-1" }),
      });

      const res = await POST(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toContain("Forbidden workspace");
    });

    it("maps InvalidMasterDataError to 422 with error_name", async () => {
      mockDispatch.mockRejectedValue(new InvalidMasterDataError("Missing required field: assetId"));
      const req = new NextRequest("http://localhost/api/fund-ledger/ai-opinion", {
        method: "POST",
        body: JSON.stringify({ asset_id: "asset-1" }),
      });

      const res = await POST(req);
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain("Missing required field: assetId");
      expect(json.error_name).toBe("InvalidMasterDataError");
    });

    it("maps unexpected operational failure to 500", async () => {
      mockDispatch.mockRejectedValue(new Error("queue unavailable"));
      const req = new NextRequest("http://localhost/api/fund-ledger/ai-opinion", {
        method: "POST",
        body: JSON.stringify({ asset_id: "asset-1" }),
      });

      const res = await POST(req);
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toContain("queue unavailable");
    });
  });

  describe("DELETE", () => {
    it("clears AI opinion for asset", async () => {
      mockClear.mockResolvedValue({ id: "asset-1" });
      const req = new NextRequest("http://localhost/api/fund-ledger/ai-opinion", {
        method: "DELETE",
        body: JSON.stringify({ asset_id: "asset-1" }),
      });

      const res = await DELETE(req);
      expect(res.status).toBe(200);
      expect(mockClear).toHaveBeenCalledWith("asset-1");
    });

    it("rejects delete request missing asset_id with 422", async () => {
      const req = new NextRequest("http://localhost/api/fund-ledger/ai-opinion", {
        method: "DELETE",
        body: JSON.stringify({}),
      });

      const res = await DELETE(req);
      expect(res.status).toBe(422);
    });

    it("maps EntityNotFoundError to 404", async () => {
      mockClear.mockRejectedValue(new EntityNotFoundError("Asset not found"));
      const req = new NextRequest("http://localhost/api/fund-ledger/ai-opinion", {
        method: "DELETE",
        body: JSON.stringify({ asset_id: "nonexistent" }),
      });

      const res = await DELETE(req);
      expect(res.status).toBe(404);
    });
  });
});
