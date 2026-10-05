import { beforeEach, describe, expect, it, vi } from "vitest";

const { list, createDb, getActiveWorkspaceId, repoConstructor } = vi.hoisted(() => ({
  list: vi.fn(),
  createDb: vi.fn(),
  getActiveWorkspaceId: vi.fn(),
  repoConstructor: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({ createDb }));
vi.mock("@/lib/workspace", () => ({ getActiveWorkspaceId }));
vi.mock("@/lib/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repositories")>();
  class MockPipelineStageRepository {
    constructor(db: unknown, workspaceId: string) {
      repoConstructor(db, workspaceId);
    }
    list = list;
  }
  return { ...actual, PipelineStageRepository: MockPipelineStageRepository };
});

import { listPipelineStages } from "./list_pipeline_stages";

function row(key: string, code: string, name: string, deleted = false) {
  return { key, code, name, deleted_at: deleted ? "2026-10-01T00:00:00Z" : null };
}

describe("list_pipeline_stages", () => {
  beforeEach(() => {
    list.mockReset();
    createDb.mockReset().mockReturnValue({ client: "db" });
    getActiveWorkspaceId.mockReset().mockResolvedValue("ws-a");
    repoConstructor.mockReset();
  });

  it("lists the live stages in order with code, name and key, scoped to the workspace", async () => {
    list.mockResolvedValue([
      row("L0", "L0", "Company Sourcing"),
      row("stg-calls", "L1b", "Expert Calls"),
      row("L2", "L2", "Deep Dive", true),
    ]);

    const out = (await listPipelineStages.invoke({})) as string;

    expect(repoConstructor).toHaveBeenCalledWith({ client: "db" }, "ws-a");
    expect(out).toContain("| 1 | L0 | Company Sourcing | L0 |");
    expect(out).toContain("| 2 | L1b | Expert Calls | stg-calls |");
    expect(out).not.toContain("Deep Dive");
  });

  it("shows deleted stages only when asked", async () => {
    list.mockResolvedValue([row("L0", "L0", "Company Sourcing"), row("L2", "L2", "Deep Dive", true)]);
    const out = (await listPipelineStages.invoke({ include_deleted: true })) as string;
    expect(out).toContain("Deleted stages");
    expect(out).toContain("| L2 | Deep Dive | L2 |");
  });

  it("returns an error string instead of throwing", async () => {
    list.mockRejectedValue(new Error("db down"));
    await expect(listPipelineStages.invoke({})).resolves.toBe("**Error:** db down");
  });
});
