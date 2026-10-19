import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST, GET, DELETE } from "./route";
import { EntityNotFoundError, InvalidMasterDataError, WorkspaceMismatchError } from "@/lib/services";

vi.mock("@/lib/server/db", () => ({
  createDb: vi.fn().mockReturnValue({}),
}));

vi.mock("@/lib/workspace", () => ({
  getActiveWorkspaceId: vi.fn().mockResolvedValue("ws-test"),
}));

const mockDispatch = vi.fn();
const mockClear = vi.fn();
const mockGetOpinion = vi.fn();

vi.mock("@/lib/services/container", () => ({
  createContainer: vi.fn().mockReturnValue({
    fundAiOpinionService: {
      dispatch: (...args: unknown[]) => mockDispatch(...args),
      clear: (...args: unknown[]) => mockClear(...args),
      getOpinion: (...args: unknown[]) => mockGetOpinion(...args),
    },
  }),
}));

describe("API /api/fund-ledger/assets/[id]/ai-opinion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST", () => {
    it("dispatches AI opinion for asset and ignores any caller-supplied internal/audit IDs", async () => {
      mockDispatch.mockResolvedValue({ runId: "run-123" });
      const req = new NextRequest("http://localhost/api/fund-ledger/assets/asset-1/ai-opinion", {
        method: "POST",
        body: JSON.stringify({
          triggered_by_user_id: "malicious-user-id",
          userId: "malicious-user-id-2",
          created_by: "attacker",
          audit_id: "forged-id",
        }),
      });

      const res = await POST(req, { params: Promise.resolve({ id: "asset-1" }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toEqual({ data: { runId: "run-123" } });
      // Verified: caller-supplied user IDs in payload are NOT passed to service
      expect(mockDispatch).toHaveBeenCalledWith("asset-1", null);
    });

    it("maps EntityNotFoundError to 404", async () => {
      mockDispatch.mockRejectedValue(new EntityNotFoundError("Asset not found"));
      const req = new NextRequest("http://localhost/api/fund-ledger/assets/nonexistent/ai-opinion", {
        method: "POST",
      });

      const res = await POST(req, { params: Promise.resolve({ id: "nonexistent" }) });
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json.error).toContain("not found");
    });

    it("maps WorkspaceMismatchError to 403", async () => {
      mockDispatch.mockRejectedValue(new WorkspaceMismatchError("Forbidden workspace"));
      const req = new NextRequest("http://localhost/api/fund-ledger/assets/asset-1/ai-opinion", {
        method: "POST",
      });

      const res = await POST(req, { params: Promise.resolve({ id: "asset-1" }) });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toContain("Forbidden workspace");
    });

    it("maps InvalidMasterDataError to 422 with error_name", async () => {
      mockDispatch.mockRejectedValue(new InvalidMasterDataError("Missing required field: assetId"));
      const req = new NextRequest("http://localhost/api/fund-ledger/assets/asset-1/ai-opinion", {
        method: "POST",
      });

      const res = await POST(req, { params: Promise.resolve({ id: "asset-1" }) });
      expect(res.status).toBe(422);
      const json = await res.json();
      expect(json.error).toContain("Missing required field: assetId");
      expect(json.error_name).toBe("InvalidMasterDataError");
    });

    it("maps unexpected operational failure to 500", async () => {
      mockDispatch.mockRejectedValue(new Error("queue unavailable"));
      const req = new NextRequest("http://localhost/api/fund-ledger/assets/asset-1/ai-opinion", {
        method: "POST",
      });

      const res = await POST(req, { params: Promise.resolve({ id: "asset-1" }) });
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toContain("queue unavailable");
    });
  });

  describe("GET", () => {
    it("returns opinion status for asset", async () => {
      mockGetOpinion.mockResolvedValue({ verdict: "buy", summary: "Solid investment", status: "completed" });
      const req = new NextRequest("http://localhost/api/fund-ledger/assets/asset-1/ai-opinion", {
        method: "GET",
      });

      const res = await GET(req, { params: Promise.resolve({ id: "asset-1" }) });
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.ai_opinion.verdict).toBe("buy");
    });

    it("maps EntityNotFoundError to 404", async () => {
      mockGetOpinion.mockRejectedValue(new EntityNotFoundError("Asset not found"));
      const req = new NextRequest("http://localhost/api/fund-ledger/assets/nonexistent/ai-opinion", {
        method: "GET",
      });

      const res = await GET(req, { params: Promise.resolve({ id: "nonexistent" }) });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE", () => {
    it("clears AI opinion for asset", async () => {
      mockClear.mockResolvedValue({ id: "asset-1" });
      const req = new NextRequest("http://localhost/api/fund-ledger/assets/asset-1/ai-opinion", {
        method: "DELETE",
      });

      const res = await DELETE(req, { params: Promise.resolve({ id: "asset-1" }) });
      expect(res.status).toBe(200);
      expect(mockClear).toHaveBeenCalledWith("asset-1");
    });

    it("maps EntityNotFoundError to 404", async () => {
      mockClear.mockRejectedValue(new EntityNotFoundError("Asset not found"));
      const req = new NextRequest("http://localhost/api/fund-ledger/assets/nonexistent/ai-opinion", {
        method: "DELETE",
      });

      const res = await DELETE(req, { params: Promise.resolve({ id: "nonexistent" }) });
      expect(res.status).toBe(404);
    });
  });
});
