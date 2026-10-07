import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  findByNameFuzzy,
  create,
  updateFinancials,
  createNote,
  findAllInWorkspace,
  createDb,
  createContainer,
  getCopilotAgent,
} = vi.hoisted(() => ({
  findByNameFuzzy: vi.fn(),
  create: vi.fn(),
  updateFinancials: vi.fn(),
  createNote: vi.fn(),
  findAllInWorkspace: vi.fn(),
  createDb: vi.fn(),
  createContainer: vi.fn(),
  getCopilotAgent: vi.fn(),
}));

vi.mock("@/lib/server/db", () => ({ createDb }));

vi.mock("@/lib/services", () => ({ createContainer }));

vi.mock("@/lib/repositories", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/repositories")>();
  class MockCompanyRepository {
    findByNameFuzzy = findByNameFuzzy;
  }
  class MockUserRepository {
    findAllInWorkspace = findAllInWorkspace;
  }
  return {
    ...actual,
    CompanyRepository: MockCompanyRepository,
    UserRepository: MockUserRepository,
  };
});

import { addCompany } from "./add_company";

// Helper widens enum-constrained fields to string so we can cover the
// schema-rejection tests with out-of-enum values; the tool's runtime invoke
// accepts them (LangChain validates inside) and the schema layer throws.
async function call(args: {
  target?: string;
  project_name?: string;
  stage?: string;
  segment?: string;
  geography?: string;
  source?: string;
  note?: string;
  company_focus?: string;
  website?: string;
  ownership?: string;
  comments?: string;
  remarks?: string;
  thesis_content?: string;
  context?: string;
  segment_related_offerings?: string;
  deal_type?: string;
  stake?: string;
  deal_size?: string;
  doc_type?: string;
  workflow_status?: string;
  key_rationale?: string;
  nbo_date?: string;
  is_live?: boolean;
  banker?: string;
  banker_source?: string;
  advisor?: string;
  originator?: string;
  deal_sponsor?: string;
  deal_captain?: string;
  entered_by?: string;
  watchlist_id?: number;
  watchlist_status?: string;
  financials?: Array<{
    fiscal_year: number;
    revenue_usd_mn?: number;
    ebitda_usd_mn?: number;
    ev_usd_mn?: number;
  }>;
}) {
  return addCompany.invoke(args as never);
}

describe("add_company (workforce tool)", () => {
  beforeEach(() => {
    findByNameFuzzy.mockReset();
    create.mockReset();
    updateFinancials.mockReset().mockResolvedValue({});
    createNote.mockReset().mockResolvedValue({ id: "n-1" });
    findAllInWorkspace.mockReset().mockResolvedValue([
      { id: "u-nur", name: "Nur Khairusy", email: "nur@example.com" },
      { id: "u-james", name: "James Wong", email: "james@example.com" },
    ]);
    createDb.mockReset().mockReturnValue({});
    getCopilotAgent.mockReset().mockResolvedValue("mna");
    createContainer.mockReset().mockReturnValue({
      companyService: { create, updateFinancials },
      dealNoteService: { create: createNote },
      workspaceService: { getCopilotAgent },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("refuses a call with neither a target nor a project name", async () => {
    for (const args of [
      { target: "   " },
      { project_name: "  " },
      { target: "   ", project_name: "  " },
      {},
    ]) {
      const result = await call(args);
      expect(String(result)).toMatch(/At least one is required/);
    }
    expect(findByNameFuzzy).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("creates a company under its project name alone", async () => {
    findByNameFuzzy.mockResolvedValue(null);
    create.mockResolvedValueOnce({ id: "c-new" });

    const result = await call({ project_name: "Project Sunrise" });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ project_name: "Project Sunrise" }),
      expect.any(String),
    );
    // No invented target — the column is simply absent.
    expect(create.mock.calls[0][0]).not.toHaveProperty("target");
    expect(String(result)).toMatch(/Added "\[Project Sunrise\]" to the database/);
  });

  it("records both names when the intake gives a company name and a codename", async () => {
    findByNameFuzzy.mockResolvedValue(null);
    create.mockResolvedValueOnce({ id: "c-new" });

    const result = await call({ target: "Acme", project_name: "Project Sunrise" });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ target: "Acme", project_name: "Project Sunrise" }),
      expect.any(String),
    );
    expect(String(result)).toMatch(/Acme \[Project Sunrise\]/);
  });

  it("checks BOTH supplied names against existing companies before inserting", async () => {
    // The real name is new but the codename already belongs to a record.
    findByNameFuzzy.mockImplementation(async (name: string) =>
      name === "Project Sunrise"
        ? { id: "c-old", target: "Acme Corp", project_name: "Project Sunrise", pipeline_stage: "L1" }
        : null,
    );

    const result = await call({ target: "Acme", project_name: "Project Sunrise" });

    expect(create).not.toHaveBeenCalled();
    expect(String(result)).toMatch(/already exists in the pipeline \(id: c-old/);
    expect(String(result)).toMatch(/update_company_details/);
  });

  it("records the deal shape fields given at create time", async () => {
    findByNameFuzzy.mockResolvedValue(null);
    create.mockResolvedValueOnce({ id: "c-new" });

    await call({
      target: "Acme",
      deal_type: "minority",
      stake: "30%",
      deal_size: "$120M",
      doc_type: "teaser",
      workflow_status: "First contact made",
      key_rationale: "Anchor asset for the platform thesis.",
      nbo_date: "2026-09-30",
      is_live: true,
      banker: "Golden Sacks",
      banker_source: "Shopping list",
      advisor: "Golden Sacks",
      originator: "James Wong",
      segment_related_offerings: "CMP slurry",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        deal_type: "minority",
        stake: "30%",
        deal_size: "$120M",
        doc_type: "teaser",
        workflow_status: "First contact made",
        key_rationale: "Anchor asset for the platform thesis.",
        nbo_date: "2026-09-30",
        is_live: true,
        banker: "Golden Sacks",
        banker_source: "Shopping list",
        advisor: "Golden Sacks",
        originator: "James Wong",
        segment_related_offerings: "CMP slurry",
      }),
      expect.any(String),
    );
  });

  it("stamps the workspace flavor's default deal_type when none is given", async () => {
    // A capital-markets desk should not accumulate deals labelled "majority"
    // just because that is the column default.
    findByNameFuzzy.mockResolvedValue(null);
    create.mockResolvedValueOnce({ id: "c-new" });
    getCopilotAgent.mockResolvedValue("capital_markets");

    await call({ target: "Acme" });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ deal_type: "ipo" }),
      expect.any(String),
    );
  });

  it("lets an explicit deal_type beat the flavor default", async () => {
    findByNameFuzzy.mockResolvedValue(null);
    create.mockResolvedValueOnce({ id: "c-new" });
    getCopilotAgent.mockResolvedValue("capital_markets");

    await call({ target: "Acme", deal_type: "bond_issuance" });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ deal_type: "bond_issuance" }),
      expect.any(String),
    );
  });

  it("falls back to the mna default for a flavor key this build doesn't know", async () => {
    findByNameFuzzy.mockResolvedValue(null);
    create.mockResolvedValueOnce({ id: "c-new" });
    getCopilotAgent.mockResolvedValue("written_by_a_newer_deploy" as never);

    await call({ target: "Acme" });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ deal_type: "majority" }),
      expect.any(String),
    );
  });

  it("rejects a deal_type it cannot normalize", async () => {
    findByNameFuzzy.mockResolvedValue(null);

    const result = await call({ target: "Acme", deal_type: "controlling" });

    expect(result).toMatch(/deal_type must be one of/i);
    expect(create).not.toHaveBeenCalled();
  });

  it("normalizes human spellings of deal_type before insert", async () => {
    findByNameFuzzy.mockResolvedValue(null);
    create.mockResolvedValueOnce({ id: "c-new" });

    await call({ target: "Acme", deal_type: "M&A Advisory" });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ deal_type: "ma_advisory" }),
      expect.any(String),
    );
  });

  it("rejects a malformed nbo_date via the schema layer", async () => {
    await expect(call({ target: "Acme", nbo_date: "30 Sep 2026" })).rejects.toThrow(
      /nbo_date must be YYYY-MM-DD/,
    );
    expect(findByNameFuzzy).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("resolves the people columns from names to workspace user ids", async () => {
    findByNameFuzzy.mockResolvedValue(null);
    create.mockResolvedValueOnce({ id: "c-new" });

    await call({
      target: "Acme",
      deal_sponsor: "nur khairusy",
      deal_captain: "james@example.com",
      entered_by: "u-nur",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        deal_sponsor: "u-nur",
        deal_captain: "u-james",
        entered_by: "u-nur",
      }),
      expect.any(String),
    );
    // One members read for all three fields, never one per column.
    expect(findAllInWorkspace).toHaveBeenCalledTimes(1);
  });

  it("does not read the workspace members when no people field is passed", async () => {
    findByNameFuzzy.mockResolvedValue(null);
    create.mockResolvedValueOnce({ id: "c-new" });

    await call({ target: "Acme" });

    expect(findAllInWorkspace).not.toHaveBeenCalled();
  });

  it("refuses rather than creating a company when a person name matches nobody", async () => {
    findByNameFuzzy.mockResolvedValue(null);

    const result = await call({ target: "Acme", deal_sponsor: "Ghost Person" });

    expect(String(result)).toMatch(/no workspace member matches deal_sponsor "Ghost Person"/);
    expect(String(result)).toMatch(/Nur Khairusy/); // names the real options
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses an ambiguous person name instead of guessing which one was meant", async () => {
    findByNameFuzzy.mockResolvedValue(null);
    findAllInWorkspace.mockResolvedValue([
      { id: "u-1", name: "Alex Tan", email: "alex.tan@example.com" },
      { id: "u-2", name: "Alex Tan", email: "a.tan@example.com" },
    ]);

    const result = await call({ target: "Acme", deal_sponsor: "Alex Tan" });

    expect(String(result)).toMatch(/matches 2 workspace members/);
    expect(String(result)).toMatch(/alex\.tan@example\.com/);
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

  it("inserts at the 'unreviewed' stage with logAction 'CREATED_AS_UNREVIEWED' when a human requested the add via chat", async () => {
    findByNameFuzzy.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({ id: "c-new" });

    const result = await call({ target: "ChatCo", stage: "unreviewed" });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ pipeline_stage: "unreviewed", status: "active" }),
      "CREATED_AS_UNREVIEWED",
    );
    expect(String(result)).toMatch(/to the database at unreviewed/);
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

  it("saves a real note to the company's notes timeline and reports it", async () => {
    findByNameFuzzy.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({ id: "c-new" });

    const result = await call({
      target: "Acme",
      note: "Surfaced from APAC scan, no financials yet.",
    });

    expect(createNote).toHaveBeenCalledWith(
      "c-new",
      "Surfaced from APAC scan, no financials yet.",
      "market_screening",
    );
    expect(String(result)).toMatch(
      /Note recorded on the timeline: Surfaced from APAC scan, no financials yet\./,
    );
  });

  it("does not touch the notes timeline when the note is blank", async () => {
    findByNameFuzzy.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({ id: "c-new" });

    await call({ target: "Acme", note: "   " });

    expect(createNote).not.toHaveBeenCalled();
  });

  it("still reports the company as created when the note write fails", async () => {
    findByNameFuzzy.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({ id: "c-new" });
    createNote.mockRejectedValueOnce(new Error("notes table is down"));

    const result = await call({ target: "Acme", note: "Check the teaser." });

    expect(String(result)).toMatch(/Added "Acme" to the database/);
    expect(String(result)).toMatch(/notes table is down/);
    expect(String(result)).toMatch(/Check the teaser\./);
  });

  it("records the markdown context on the new company row", async () => {
    findByNameFuzzy.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({ id: "c-new" });

    await call({
      target: "Acme",
      context: "  ## Background\nFamily-owned, approached via the SEMICON intro.  ",
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        context: "## Background\nFamily-owned, approached via the SEMICON intro.",
      }),
      expect.any(String),
    );
  });

  it("drops a blank context rather than storing an empty string", async () => {
    findByNameFuzzy.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({ id: "c-new" });

    await call({ target: "Acme", context: "   " });

    expect(create).toHaveBeenCalledWith(
      expect.not.objectContaining({ context: expect.anything() }),
      expect.any(String),
    );
  });

  it("records the company details given at create time, dropping blank ones", async () => {
    findByNameFuzzy.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({ id: "c-new" });

    await call({
      target: "Acme",
      stage: "unreviewed",
      company_focus: " Makes CMP slurry. ",
      website: "https://acme.example",
      ownership: "PE-backed",
      comments: "Met at SEMICON",
      remarks: "   ",
      thesis_content: "Fits the roll-up",
      watchlist_id: 42,
      watchlist_status: "watching",
    });

    const args = create.mock.calls[0][0] as Record<string, unknown>;
    expect(args).toMatchObject({
      company_focus: "Makes CMP slurry.",
      website: "https://acme.example",
      ownership: "PE-backed",
      comments: "Met at SEMICON",
      thesis_content: "Fits the roll-up",
      watchlist_id: 42,
      watchlist_status: "watching",
    });
    expect(args).not.toHaveProperty("remarks");
    expect(updateFinancials).not.toHaveBeenCalled();
  });

  it("saves financials for the new company through the service and names the years", async () => {
    findByNameFuzzy.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({ id: "c-new" });
    const rows = [{ fiscal_year: 2025, revenue_usd_mn: 25.5, ebitda_usd_mn: 4, ev_usd_mn: 60 }];

    const result = await call({ target: "Acme", stage: "unreviewed", financials: rows });

    expect(updateFinancials).toHaveBeenCalledWith(
      "c-new",
      rows,
      [],
      "UPDATED_FINANCIALS_BY_AI_WORKFORCE",
    );
    expect(String(result)).toMatch(/Added "Acme".*Financials saved for FY2025\./);
  });

  it("reports the partial state when the company lands but the financials write fails", async () => {
    findByNameFuzzy.mockResolvedValueOnce(null);
    create.mockResolvedValueOnce({ id: "c-new" });
    updateFinancials.mockRejectedValueOnce(new Error("db down"));

    const result = await call({
      target: "Acme",
      financials: [{ fiscal_year: 2025, revenue_usd_mn: 10 }],
    });

    expect(String(result)).toMatch(/Added "Acme".*id: c-new/);
    expect(String(result)).toMatch(/financials failed to save: db down/);
    expect(String(result)).toMatch(/update_company_details/);
  });

  it("rejects a financials year listed twice before creating anything", async () => {
    const result = await call({
      target: "Acme",
      financials: [
        { fiscal_year: 2025, revenue_usd_mn: 10 },
        { fiscal_year: 2025, ebitda_usd_mn: 2 },
      ],
    });

    expect(String(result)).toMatch(/fiscal_year 2025 appears more than once/);
    expect(findByNameFuzzy).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a financials row with no figures before creating anything", async () => {
    const result = await call({ target: "Acme", financials: [{ fiscal_year: 2025 }] });

    expect(String(result)).toMatch(/sets no figures/);
    expect(create).not.toHaveBeenCalled();
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
