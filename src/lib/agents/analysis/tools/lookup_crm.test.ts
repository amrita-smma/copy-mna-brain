import { afterEach, describe, expect, it, vi } from "vitest";

const employerListMock = vi.fn();
const findByEmployerIdMock = vi.fn();
const listForEmployerMock = vi.fn();
const noteFindByEmployerIdMock = vi.fn();
const topicListForEmployerMock = vi.fn();
const teamListForEmployerMock = vi.fn();
const emailFindByEmployerIdMock = vi.fn();
const searchMock = vi.fn();
const topicListForEmployersMock = vi.fn();
const teamListForEmployersMock = vi.fn();

vi.mock("@/lib/server/db", () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock("@/lib/workspace", () => ({
  getActiveWorkspaceId: vi.fn(() => Promise.resolve("ws-1")),
}));

vi.mock("@/lib/repositories", () => ({
  EmployerRepository: function EmployerRepository() {
    return { list: employerListMock };
  },
  CorrespondentRepository: function CorrespondentRepository() {
    return { findByEmployerId: findByEmployerIdMock, search: searchMock };
  },
  EmployerRelatedCompanyRepository: function EmployerRelatedCompanyRepository() {
    return { listForEmployer: listForEmployerMock };
  },
  EmployerNoteRepository: function EmployerNoteRepository() {
    return { findByEmployerId: noteFindByEmployerIdMock };
  },
  TopicRepository: function TopicRepository() {
    return {
      listForEmployer: topicListForEmployerMock,
      listForEmployers: topicListForEmployersMock,
    };
  },
  EmployerTeamRepository: function EmployerTeamRepository() {
    return {
      listForEmployer: teamListForEmployerMock,
      listForEmployers: teamListForEmployersMock,
    };
  },
  EmailRepository: function EmailRepository() {
    return { findByEmployerId: emailFindByEmployerIdMock };
  },
}));

import { lookupCrm } from "./lookup_crm";

// Default every secondary lookup to empty so individual tests only set up the
// repos they care about.
afterEach(() => vi.clearAllMocks());

function emptyRelations() {
  findByEmployerIdMock.mockResolvedValue([]);
  listForEmployerMock.mockResolvedValue([]);
  noteFindByEmployerIdMock.mockResolvedValue([]);
  topicListForEmployerMock.mockResolvedValue([]);
  teamListForEmployerMock.mockResolvedValue([]);
  emailFindByEmployerIdMock.mockResolvedValue([]);
}

describe("lookupCrm", () => {
  it("asks for input when the query is blank", async () => {
    const result = (await lookupCrm.invoke({ query: "   " })) as string;
    expect(result).toContain("Please provide a firm name");
    expect(employerListMock).not.toHaveBeenCalled();
  });

  it("returns a not-found message when no firms match", async () => {
    employerListMock.mockResolvedValue([]);
    const result = (await lookupCrm.invoke({ query: "Ghost Bank" })) as string;
    expect(employerListMock).toHaveBeenCalledWith({ search: "Ghost Bank", limit: 5 }, "ws-1");
    expect(result).toContain('No CRM firms or bankers found matching "Ghost Bank"');
  });

  it("renders matching firms with their bankers", async () => {
    employerListMock.mockResolvedValue([
      {
        id: "emp-1",
        name: "Evercore",
        industry: "Investment Banking",
        status: "inbound",
        email_count: 12,
        last_contact_at: "2026-06-01T00:00:00.000Z",
      },
    ]);
    emptyRelations();
    findByEmployerIdMock.mockResolvedValue([
      {
        name: "Jane Doe",
        title: "Managing Director",
        email: "jane@evercore.com",
        phone: "+1 555 1000",
        is_primary: true,
      },
      {
        name: "John Roe",
        title: null,
        email: "john@evercore.com",
        phone: null,
        is_primary: false,
      },
    ]);
    listForEmployerMock.mockResolvedValue([
      {
        company_id: "co-1",
        company_name: "Acme Corp",
        normalized_company_name: "acme corp",
        confidence: "high",
        evidence: [],
      },
    ]);

    const result = (await lookupCrm.invoke({ query: "Evercore" })) as string;

    expect(findByEmployerIdMock).toHaveBeenCalledWith("emp-1", "ws-1");
    expect(listForEmployerMock).toHaveBeenCalledWith("emp-1", "ws-1");
    expect(result).toContain("## Evercore");
    expect(result).toContain("**Industry:** Investment Banking");
    expect(result).toContain("**Jane Doe** (primary) — Managing Director — jane@evercore.com");
    expect(result).toContain("**John Roe** — john@evercore.com");
    expect(result).toContain("Acme Corp (confidence: high)");
  });

  it("renders a banker's desk, focus, coverage and background", async () => {
    employerListMock.mockResolvedValue([
      {
        id: "emp-1",
        name: "Evercore",
        industry: "Investment Banking",
        status: "inbound",
        email_count: 1,
        last_contact_at: null,
      },
    ]);
    emptyRelations();
    findByEmployerIdMock.mockResolvedValue([
      {
        name: "Jane Doe",
        title: "MD, TMT",
        seniority: "Managing Director",
        department: "M&A",
        specialization: "Semiconductors",
        coverage_region: "Asia Pacific",
        bio: "Ex-Lazard; brought us three carve-outs.",
        email: "jane@evercore.com",
        phone: null,
        is_primary: true,
      },
    ]);

    const result = (await lookupCrm.invoke({ query: "Evercore" })) as string;

    expect(result).toContain(
      "**Jane Doe** (primary) — MD, TMT — M&A desk — Managing Director — focus: Semiconductors — covers Asia Pacific — jane@evercore.com",
    );
    expect(result).toContain("_Ex-Lazard; brought us three carve-outs._");
  });

  it("does not repeat seniority when it already equals the title", async () => {
    employerListMock.mockResolvedValue([
      {
        id: "emp-1",
        name: "Evercore",
        industry: null,
        status: "inbound",
        email_count: 0,
        last_contact_at: null,
      },
    ]);
    emptyRelations();
    findByEmployerIdMock.mockResolvedValue([
      {
        name: "Jane Doe",
        title: "Managing Director",
        seniority: "Managing Director",
        department: null,
        specialization: null,
        coverage_region: null,
        bio: null,
        email: null,
        phone: null,
        is_primary: false,
      },
    ]);

    const result = (await lookupCrm.invoke({ query: "Evercore" })) as string;

    expect(result).toContain("- **Jane Doe** — Managing Director\n");
    expect(result).not.toContain("Managing Director — Managing Director");
  });

  it("renders topics, team coverage, recent emails, and notes", async () => {
    employerListMock.mockResolvedValue([
      {
        id: "emp-1",
        name: "Evercore",
        industry: "Investment Banking",
        status: "inbound",
        email_count: 3,
        last_contact_at: "2026-06-01T00:00:00.000Z",
      },
    ]);
    emptyRelations();
    topicListForEmployerMock.mockResolvedValue([
      { id: "t1", topic_id: "t1", name: "Acquisition", slug: "acquisition", source: "auto", is_highlight: true },
      { id: "t2", topic_id: "t2", name: "Financing", slug: "financing", source: "manual", is_highlight: false },
    ]);
    teamListForEmployerMock.mockResolvedValue([
      { id: "u1", name: "Alice Banker", email: "alice@firm.com" },
      { id: "u2", name: "Bob Analyst", email: null },
    ]);
    emailFindByEmployerIdMock.mockResolvedValue([
      {
        sent_at: "2026-06-01T09:00:00.000Z",
        direction: "inbound",
        from_display_name: "Jane Doe",
        from_address: "jane@evercore.com",
      },
      {
        sent_at: "2026-05-28T09:00:00.000Z",
        direction: "outbound",
        from_display_name: null,
        from_address: "us@ourfirm.com",
      },
    ]);
    noteFindByEmployerIdMock.mockResolvedValue([
      { content: "Discussed potential CMP slurry deal.", created_at: "2026-05-30T00:00:00.000Z" },
    ]);

    const result = (await lookupCrm.invoke({ query: "Evercore" })) as string;

    expect(emailFindByEmployerIdMock).toHaveBeenCalledWith("emp-1", { limit: 5 });
    // Topics — highlighted topic is bolded.
    expect(result).toContain("**Topics:** **Acquisition**, Financing");
    // Team coverage.
    expect(result).toContain("- Alice Banker (alice@firm.com)");
    expect(result).toContain("- Bob Analyst");
    // Recent emails — direction, date, sender.
    expect(result).toContain("### Recent emails");
    expect(result).toContain("2026-06-01 ↘ received (from Jane Doe)");
    expect(result).toContain("2026-05-28 ↗ sent (from us@ourfirm.com)");
    // Notes.
    expect(result).toContain("### Notes");
    expect(result).toContain("2026-05-30: Discussed potential CMP slurry deal.");
  });

  it("dedupes linked companies that appear under multiple sources", async () => {
    employerListMock.mockResolvedValue([
      {
        id: "emp-1",
        name: "Evercore",
        industry: null,
        status: "inbound",
        email_count: 0,
        last_contact_at: null,
      },
    ]);
    emptyRelations();
    listForEmployerMock.mockResolvedValue([
      {
        company_id: "co-1",
        company_name: "Acme Corp",
        normalized_company_name: "acme corp",
        source: "auto",
        confidence: "medium",
        evidence: [],
      },
      {
        company_id: "co-1",
        company_name: "Acme Corp",
        normalized_company_name: "acme corp",
        source: "manual",
        confidence: "high",
        evidence: [],
      },
    ]);

    const result = (await lookupCrm.invoke({ query: "Evercore" })) as string;
    expect(result.match(/Acme Corp/g)?.length).toBe(1);
  });

  it("notes when a firm has no related records on file", async () => {
    employerListMock.mockResolvedValue([
      {
        id: "emp-2",
        name: "Lonely Capital",
        industry: null,
        status: "inbound",
        email_count: 0,
        last_contact_at: null,
      },
    ]);
    emptyRelations();

    const result = (await lookupCrm.invoke({ query: "Lonely" })) as string;
    expect(result).toContain("_No bankers/correspondents on record._");
    expect(result).toContain("_No linked pipeline companies on record._");
    expect(result).toContain("**Topics:** _No topics on record._");
    expect(result).toContain("_No team members assigned._");
    expect(result).toContain("_No emails on record._");
    expect(result).toContain("_No notes on record._");
  });

  it("passes through an explicit in-range limit", async () => {
    employerListMock.mockResolvedValue([]);
    await lookupCrm.invoke({ query: "anything", limit: 10 });
    expect(employerListMock).toHaveBeenCalledWith({ search: "anything", limit: 10 }, "ws-1");
  });
});

/**
 * Banker-match mode — the "which banker can help me close this deal?" path.
 * These assert the translation from deal language (country + mandate) into the
 * CRM's own vocabulary (coverage region + desk), because that translation is
 * the whole point of the mode.
 */
describe("lookupCrm — banker match mode", () => {
  function noFirmExtras() {
    topicListForEmployersMock.mockResolvedValue([]);
    teamListForEmployersMock.mockResolvedValue([]);
  }

  it("translates a country into coverage regions and a mandate into desks", async () => {
    searchMock.mockResolvedValue([]);
    noFirmExtras();

    await lookupCrm.invoke({ geography: "United States", deal_type: "LBO" });

    const [filters, workspaceId] = searchMock.mock.calls[0];
    expect(workspaceId).toBe("ws-1");
    // "United States" is never written in coverage_region — "North America" is.
    expect(filters.regions).toEqual(expect.arrayContaining(["United States", "North America"]));
    expect(filters.broadRegions).toContain("Global");
    // "LBO" is never written in department — "Leveraged Finance" is.
    expect(filters.departments).toEqual(
      expect.arrayContaining(["Leveraged Finance", "Debt Capital Markets"]),
    );
    expect(filters.expertise).toContain("LBO");
    // Banker-match mode defaults to a wider result set than firm profiles.
    expect(filters.limit).toBe(10);
    expect(employerListMock).not.toHaveBeenCalled();
  });

  it("ranks matched bankers and says why each one matched", async () => {
    searchMock.mockResolvedValue([
      {
        id: "c1",
        name: "Jane Doe",
        title: "Managing Director",
        email: "jane@gs.com",
        phone: "+1 555 1000",
        department: "Leveraged Finance",
        specialization: "Sponsor-backed LBO financing",
        seniority: "Managing Director",
        coverage_region: "North America",
        linkedin_url: null,
        bio: "Ran 20 US LBOs.",
        employer_id: "emp-1",
        employer_name: "Goldman Sachs",
        employer_industry: "Investment Banking",
        last_contact_at: "2026-06-01T00:00:00.000Z",
        email_count: 24,
        match_score: 10,
        matched: ["departments", "regions", "expertise"],
      },
      {
        id: "c2",
        name: "Bob Lim",
        title: "Director",
        email: "bob@gs.com",
        phone: null,
        department: "Leveraged Finance",
        specialization: null,
        seniority: "Director",
        coverage_region: "Greater China",
        linkedin_url: null,
        bio: null,
        employer_id: "emp-1",
        employer_name: "Goldman Sachs",
        employer_industry: "Investment Banking",
        last_contact_at: null,
        email_count: 24,
        match_score: 5,
        matched: ["departments"],
      },
    ]);
    topicListForEmployersMock.mockResolvedValue([
      { employer_id: "emp-1", name: "LBO financing", is_deal_related: true },
    ]);
    teamListForEmployersMock.mockResolvedValue([
      { employer_id: "emp-1", id: "u1", name: "Nico", email: "nico@sqe.co.id" },
    ]);

    const result = (await lookupCrm.invoke({
      geography: "United States",
      deal_type: "LBO",
    })) as string;

    expect(result).toContain("### 1. Jane Doe — Managing Director, Leveraged Finance desk @ Goldman Sachs");
    expect(result).toContain("matched desk, coverage region, expertise (fit score 10)");
    expect(result).toContain("**Covers:** North America");
    expect(result).toContain("**Contact:** jane@gs.com · +1 555 1000");
    expect(result).toContain("last contact 2026-06-01");
    expect(result).toContain("**Firm topics:** **LBO financing**");
    expect(result).toContain("**Our coverage:** Nico (nico@sqe.co.id)");
    // The partial match is kept, ranked below the full one.
    expect(result.indexOf("Jane Doe")).toBeLessThan(result.indexOf("Bob Lim"));
    expect(result).toContain("### 2. Bob Lim");
    expect(result).toContain("last contact never");
  });

  it("fetches firm topics and coverage in one batched call each, not per banker", async () => {
    searchMock.mockResolvedValue(
      ["emp-1", "emp-1", "emp-2"].map((employer_id, i) => ({
        id: `c${i}`,
        name: `Banker ${i}`,
        title: null,
        email: null,
        phone: null,
        department: "M&A",
        specialization: null,
        seniority: null,
        coverage_region: null,
        linkedin_url: null,
        bio: null,
        employer_id,
        employer_name: "Firm",
        employer_industry: null,
        last_contact_at: null,
        email_count: 0,
        match_score: 3,
        matched: ["departments"],
      })),
    );
    noFirmExtras();

    await lookupCrm.invoke({ department: "M&A" });

    expect(topicListForEmployersMock).toHaveBeenCalledTimes(1);
    expect(topicListForEmployersMock).toHaveBeenCalledWith(["emp-1", "emp-2"], "ws-1");
    expect(teamListForEmployersMock).toHaveBeenCalledTimes(1);
    expect(teamListForEmployersMock).toHaveBeenCalledWith("ws-1", ["emp-1", "emp-2"]);
  });

  it("explains how the query was read, and flags terms it could not translate", async () => {
    searchMock.mockResolvedValue([]);
    noFirmExtras();

    const result = (await lookupCrm.invoke({
      geography: "Atlantis",
      deal_type: "Shariah advisory",
    })) as string;

    expect(result).toContain("**Read as:**");
    expect(result).toContain('no country or region matched "Atlantis"');
    expect(result).toContain('no desk playbook for "Shariah advisory"');
    expect(result).toContain("_No banker in this workspace's CRM matches");
  });

  it("narrows to a firm's own bankers when a firm is named alongside deal criteria", async () => {
    searchMock.mockResolvedValue([]);
    noFirmExtras();

    await lookupCrm.invoke({ firm: "Evercore", deal_type: "IPO", limit: 3 });

    const [filters] = searchMock.mock.calls[0];
    expect(filters.firm).toBe("Evercore");
    expect(filters.departments).toContain("Equity Capital Markets");
    expect(filters.limit).toBe(3);
    // A firm name alone would have gone to firm-profile mode instead.
    expect(employerListMock).not.toHaveBeenCalled();
  });

  it("still returns the firm profile when only a name is given", async () => {
    employerListMock.mockResolvedValue([]);

    await lookupCrm.invoke({ firm: "Evercore" });

    expect(employerListMock).toHaveBeenCalledWith({ search: "Evercore", limit: 5 }, "ws-1");
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("returns the firm profile for a bare banker name or email too", async () => {
    employerListMock.mockResolvedValue([]);

    await lookupCrm.invoke({ banker: "jane@evercore.com" });

    expect(employerListMock).toHaveBeenCalledWith(
      { search: "jane@evercore.com", limit: 5 },
      "ws-1",
    );
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("matches rather than profiles when two names are given, so neither is dropped", async () => {
    searchMock.mockResolvedValue([]);
    noFirmExtras();

    // Firm-profile mode searches one string, so "Jane Doe" at "Evercore" would
    // silently lose the firm constraint.
    await lookupCrm.invoke({ query: "Jane Doe", firm: "Evercore" });

    expect(employerListMock).not.toHaveBeenCalled();
    const [filters] = searchMock.mock.calls[0];
    expect(filters.keyword).toBe("Jane Doe");
    expect(filters.firm).toBe("Evercore");
  });

  it("still profiles the firm when the same name is repeated across two slots", async () => {
    employerListMock.mockResolvedValue([]);

    await lookupCrm.invoke({ query: "Evercore", firm: "Evercore" });

    expect(employerListMock).toHaveBeenCalledWith({ search: "Evercore", limit: 5 }, "ws-1");
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("matches when a banker is named alongside other free text", async () => {
    searchMock.mockResolvedValue([]);
    noFirmExtras();

    await lookupCrm.invoke({ query: "semiconductors", banker: "Jane" });

    const [filters] = searchMock.mock.calls[0];
    expect(filters.keyword).toBe("semiconductors");
    expect(filters.banker).toBe("Jane");
  });

  it("forwards free text as the keyword facet alongside deal criteria", async () => {
    searchMock.mockResolvedValue([]);
    noFirmExtras();

    await lookupCrm.invoke({ query: "semiconductors", geography: "Indonesia" });

    const [filters] = searchMock.mock.calls[0];
    expect(filters.keyword).toBe("semiconductors");
    expect(filters.regions).toContain("Southeast Asia");
  });

  it("surfaces a repository failure as an error string rather than throwing", async () => {
    searchMock.mockRejectedValue(new Error("connection terminated"));

    const result = (await lookupCrm.invoke({ geography: "Indonesia" })) as string;
    expect(result).toContain("**Error:** connection terminated");
  });
});
