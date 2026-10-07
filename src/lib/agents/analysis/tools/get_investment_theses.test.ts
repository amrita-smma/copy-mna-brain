import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  findAllActive,
  findAll,
  createDb,
  getActiveWorkspaceId,
  mockRepositoryConstructor,
} = vi.hoisted(() => ({
  findAllActive: vi.fn(),
  findAll: vi.fn(),
  createDb: vi.fn(),
  getActiveWorkspaceId: vi.fn(),
  mockRepositoryConstructor: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({ createDb }));

vi.mock("@/lib/workspace", () => ({ getActiveWorkspaceId }));

vi.mock("@/lib/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repositories")>();
  class MockInvestmentThesisRepository {
    constructor(db: unknown, workspaceId: string) {
      mockRepositoryConstructor(db, workspaceId);
    }
    findAllActive = findAllActive;
    findAll = findAll;
  }
  return {
    ...actual,
    InvestmentThesisRepository: MockInvestmentThesisRepository,
  };
});

import { getInvestmentTheses } from "./get_investment_theses";

const mockDbInstance = { client: "mock-db" };

describe("get_investment_theses", () => {
  beforeEach(() => {
    findAllActive.mockReset();
    findAll.mockReset();
    createDb.mockReset().mockReturnValue(mockDbInstance);
    getActiveWorkspaceId.mockReset().mockResolvedValue("ws-123");
    mockRepositoryConstructor.mockReset();
  });

  afterEach(() => vi.clearAllMocks());

  it("constructs InvestmentThesisRepository with db and resolved active workspaceId", async () => {
    getActiveWorkspaceId.mockResolvedValueOnce("workspace-custom-456");
    findAllActive.mockResolvedValueOnce([]);

    await getInvestmentTheses.invoke({});

    expect(createDb).toHaveBeenCalledTimes(1);
    expect(getActiveWorkspaceId).toHaveBeenCalledTimes(1);
    expect(mockRepositoryConstructor).toHaveBeenCalledWith(
      mockDbInstance,
      "workspace-custom-456",
    );
  });

  it("defaults to calling findAllActive when no arguments are provided", async () => {
    findAllActive.mockResolvedValueOnce([
      {
        id: "thesis-1",
        title: "B2B SaaS Growth",
        content: "Targeting B2B SaaS with >$5M ARR.",
        pic: "Jane Doe",
        is_active: true,
        updated_at: "2026-08-01T12:00:00Z",
      },
    ]);

    const result = (await getInvestmentTheses.invoke({})) as string;

    expect(findAllActive).toHaveBeenCalledTimes(1);
    expect(findAll).not.toHaveBeenCalled();
    expect(result).toContain("B2B SaaS Growth");
    expect(result).toContain("thesis-1");
    expect(result).toContain("Jane Doe");
  });

  it("calls findAllActive when include_inactive is explicitly false", async () => {
    findAllActive.mockResolvedValueOnce([
      {
        id: "thesis-1",
        title: "Fintech Platform",
        content: "Payments and settlement rails.",
        pic: "Alex Smith",
        is_active: true,
        updated_at: "2026-08-10T09:00:00Z",
      },
    ]);

    const result = (await getInvestmentTheses.invoke({
      include_inactive: false,
    })) as string;

    expect(findAllActive).toHaveBeenCalledTimes(1);
    expect(findAll).not.toHaveBeenCalled();
    expect(result).toContain("Fintech Platform");
  });

  it("calls findAll when include_inactive is true", async () => {
    findAll.mockResolvedValueOnce([
      {
        id: "thesis-1",
        title: "Active Healthcare",
        content: "Digital health clinics.",
        pic: "Dr. House",
        is_active: true,
        updated_at: "2026-08-05T10:00:00Z",
      },
      {
        id: "thesis-2",
        title: "Archived Hardware",
        content: "Legacy hardware systems.",
        pic: "John Doe",
        is_active: false,
        updated_at: "2026-05-01T08:00:00Z",
      },
    ]);

    const result = (await getInvestmentTheses.invoke({
      include_inactive: true,
    })) as string;

    expect(findAll).toHaveBeenCalledTimes(1);
    expect(findAllActive).not.toHaveBeenCalled();
    expect(result).toContain("Active Healthcare");
    expect(result).toContain("Archived Hardware");
    expect(result).toContain("- **Is Active:** true");
    expect(result).toContain("- **Is Active:** false");
  });

  it("returns a clear empty message when no active theses exist", async () => {
    findAllActive.mockResolvedValueOnce([]);

    const result = (await getInvestmentTheses.invoke({})) as string;

    expect(result).toContain(
      "No active investment thesis configured in this workspace.",
    );
    expect(result).toContain("This is a normal setup, not an error or a data gap");
    expect(result).toContain("Skip mandate fit entirely");
  });

  it("returns a clear empty message when no theses exist with include_inactive: true", async () => {
    findAll.mockResolvedValueOnce([]);

    const result = (await getInvestmentTheses.invoke({
      include_inactive: true,
    })) as string;

    expect(result).toContain(
      "No investment theses configured in this workspace.",
    );
    expect(result).toContain("This is a normal setup, not an error or a data gap");
    expect(result).toContain("Skip mandate fit entirely");
  });

  it("returns all active theses without choosing, scoring, or judging fit when multiple exist", async () => {
    findAllActive.mockResolvedValueOnce([
      {
        id: "thesis-1",
        title: "Enterprise AI Infrastructure",
        content: "Focus on LLM tooling and vector database providers.",
        pic: "Alice Wang",
        is_active: true,
        updated_at: "2026-08-12T14:00:00Z",
      },
      {
        id: "thesis-2",
        title: "Industrial Robotics",
        content: "Focus on warehouse automation and supply chain robotics.",
        pic: "Bob Vance",
        is_active: true,
        updated_at: "2026-08-13T16:30:00Z",
      },
      {
        id: "thesis-3",
        title: "Clean Energy Grid Software",
        content: "Focus on grid optimization and virtual power plant tech.",
        pic: "Charlie Brown",
        is_active: true,
        updated_at: "2026-08-14T08:00:00Z",
      },
    ]);

    const result = (await getInvestmentTheses.invoke({})) as string;

    expect(result).toContain("**Investment Theses (3):**");
    // Thesis 1 assertions
    expect(result).toContain("Enterprise AI Infrastructure");
    expect(result).toContain("thesis-1");
    expect(result).toContain("Alice Wang");
    expect(result).toContain(
      "Focus on LLM tooling and vector database providers.",
    );
    expect(result).toContain("2026-08-12T14:00:00Z");

    // Thesis 2 assertions
    expect(result).toContain("Industrial Robotics");
    expect(result).toContain("thesis-2");
    expect(result).toContain("Bob Vance");
    expect(result).toContain(
      "Focus on warehouse automation and supply chain robotics.",
    );
    expect(result).toContain("2026-08-13T16:30:00Z");

    // Thesis 3 assertions
    expect(result).toContain("Clean Energy Grid Software");
    expect(result).toContain("thesis-3");
    expect(result).toContain("Charlie Brown");
    expect(result).toContain(
      "Focus on grid optimization and virtual power plant tech.",
    );
    expect(result).toContain("2026-08-14T08:00:00Z");
  });

  it("handles null / missing optional fields gracefully", async () => {
    findAllActive.mockResolvedValueOnce([
      {
        id: "thesis-sparse",
        title: null,
        content: null,
        pic: null,
        is_active: true,
        updated_at: null,
      },
    ]);

    const result = (await getInvestmentTheses.invoke({})) as string;

    expect(result).toContain("thesis-sparse");
    expect(result).toContain("- **PIC:** N/A");
    expect(result).toContain("- **Updated At:** N/A");
    expect(result).toContain("(No content)");
  });

  it("returns **Error:** string when repository throws", async () => {
    findAllActive.mockRejectedValueOnce(new Error("Database connection failed"));

    const result = (await getInvestmentTheses.invoke({})) as string;

    expect(result).toBe("**Error:** Database connection failed");
  });
});
