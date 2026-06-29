import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findByNameFuzzy, create, createDb, createContainer } = vi.hoisted(
  () => ({
    findByNameFuzzy: vi.fn(),
    create: vi.fn(),
    createDb: vi.fn(),
    createContainer: vi.fn(),
  }),
);

vi.mock("@/lib/server/db", () => ({ createDb }));

vi.mock("@/lib/services", () => ({ createContainer }));

vi.mock("@/lib/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repositories")>();
  class MockCompanyRepository {
    findByNameFuzzy = findByNameFuzzy;
  }
  return {
    ...actual,
    CompanyRepository: MockCompanyRepository,
  };
});

import { addCompany } from "./add_company";

// Helper widens enum-constrained fields to string so we can cover the
// schema-rejection tests with out-of-enum values; the tool's runtime invoke
// accepts them (LangChain validates inside) and the schema layer throws.
async function call(args: {
  target: string;
  stage?: string;
  segment?: string;
  geography?: string;
  source?: string;
  note?: string;
}) {
  return addCompany.invoke(args as never);
}

describe("add_company (workforce tool)", () => {
  beforeEach(() => {
    findByNameFuzzy.mockReset();
    create.mockReset();
    createDb.mockReset().mockReturnValue({});
    createContainer.mockReset().mockReturnValue({
      companyService: { create },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("rejects an empty target", async () => {
    const result = await call({ target: "   " });
    expect(String(result)).toMatch(/target name is required/);
    expect(findByNameFuzzy).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an unknown source value via the schema layer", async () => {
    await expect(call({ target: "Acme", source: "scraped" })).rejects.toThrow(
      /did not match expected schema/i,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects an unknown stage value via the schema layer", async () => {
    await expect(call({ target: "Acme", stage: "L2" })).rejects.toThrow(
      /did not match expected schema/i,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("does NOT insert a duplicate when fuzzy match exists", async () => {
    findByNameFuzzy.mockResolvedValueOnce({
      id: "c-existing",
      target: "Acme Corp",
      pipeline_stage: "L1",
    });

    const result = await call({ target: "Acme" });

    expect(String(result)).toMatch(/already exists in the pipeline/);
    expect(String(result)).toMatch(/id: c-existing/);
    expect(String(result)).toMatch(/stage: L1/);
    expect(create).not.toHaveBeenCalled();
  });

  it("includes 'unset' when the existing company has no pipeline_stage", async () => {
    findByNameFuzzy.mockResolvedValueOnce({
      id: "c-existing",
      target: "Halcyon",
      pipeline_stage: null,
    });

    const result = await call({ target: "Halcyon" });

    expect(String(result)).toMatch(/stage: unset/);
    expect(create).not.toHaveBeenCalled();
  });

  it("defaults to the 'market_screening' stage with logAction 'CREATED_AS_MARKET_SCREENING' when no stage is given", async () => {
    findByNameFuzzy.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({ id: "c-new" });

    const result = await call({
      target: "  NovaSpec Materials  ",
      segment: " specialty chemicals ",
      geography: " Korea ",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "NovaSpec Materials",
        segment: "specialty chemicals",
        geography: "Korea",
        source: "outbound",
        pipeline_stage: "market_screening",
        status: "active",
      }),
      "CREATED_AS_MARKET_SCREENING",
    );
    expect(String(result)).toMatch(
      /Added "NovaSpec Materials" to the database at market_screening/,
    );
    expect(String(result)).toMatch(/id: c-new/);
  });

  it("refuses to add directly to L0 — the schema layer rejects it", async () => {
    await expect(call({ target: "Acme", stage: "L0" })).rejects.toThrow(
      /did not match expected schema/i,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("inserts at the 'discovered' stage with logAction 'CREATED_AS_DISCOVERED' when explicitly requested", async () => {
    findByNameFuzzy.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({ id: "c-new" });

    const result = await call({ target: "GraphCo", stage: "discovered" });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ pipeline_stage: "discovered", status: "active" }),
      "CREATED_AS_DISCOVERED",
    );
    expect(String(result)).toMatch(/to the database at discovered/);
  });

  it("inserts at market_screening with logAction 'CREATED_AS_MARKET_SCREENING'", async () => {
    findByNameFuzzy.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({ id: "c-new" });

    await call({ target: "ScanCo", stage: "market_screening" });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ pipeline_stage: "market_screening" }),
      "CREATED_AS_MARKET_SCREENING",
    );
  });

  it("defaults source to outbound and omits empty optional fields", async () => {
    findByNameFuzzy.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({ id: "c-new" });

    await call({ target: "Bare Co" });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        target: "Bare Co",
        source: "outbound",
        pipeline_stage: "market_screening",
        status: "active",
      }),
      "CREATED_AS_MARKET_SCREENING",
    );
    const args = create.mock.calls[0][0] as Record<string, unknown>;
    expect(args.segment).toBeUndefined();
    expect(args.geography).toBeUndefined();
  });

  it("accepts an explicit outbound source", async () => {
    findByNameFuzzy.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({ id: "c-new" });

    await call({ target: "OutCo", source: "outbound" });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ source: "outbound" }),
      "CREATED_AS_MARKET_SCREENING",
    );
  });

  it("treats whitespace-only notes as no note in the response", async () => {
    findByNameFuzzy.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({ id: "c-new" });

    const result = await call({ target: "Acme", note: "   " });

    expect(String(result)).not.toMatch(/Note:/);
  });

  it("appends the note suffix when a real note is provided", async () => {
    findByNameFuzzy.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({ id: "c-new" });

    const result = await call({
      target: "Acme",
      note: "Surfaced from APAC scan, no financials yet.",
    });

    expect(String(result)).toMatch(
      /Note: Surfaced from APAC scan, no financials yet\./,
    );
  });

  it("returns an **Error:** string when the service throws (does not propagate)", async () => {
    findByNameFuzzy.mockResolvedValueOnce(null);
    create.mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await call({ target: "Acme" });

    expect(String(result)).toMatch(/\*\*Error:\*\* db down/);
    errSpy.mockRestore();
  });
});
