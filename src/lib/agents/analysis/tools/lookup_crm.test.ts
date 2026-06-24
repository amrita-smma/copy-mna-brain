import { afterEach, describe, expect, it, vi } from "vitest";

const employerListMock = vi.fn();
const findByEmployerIdMock = vi.fn();
const listForEmployerMock = vi.fn();
const noteFindByEmployerIdMock = vi.fn();
const topicListForEmployerMock = vi.fn();
const teamListForEmployerMock = vi.fn();
const emailFindByEmployerIdMock = vi.fn();

vi.mock("@/lib/server/db", () => ({
  createDb: vi.fn(() => ({})),
}));

vi.mock("@/lib/repositories", () => ({
  EmployerRepository: function EmployerRepository() {
    return { list: employerListMock };
  },
  CorrespondentRepository: function CorrespondentRepository() {
    return { findByEmployerId: findByEmployerIdMock };
  },
  EmployerRelatedCompanyRepository: function EmployerRelatedCompanyRepository() {
    return { listForEmployer: listForEmployerMock };
  },
  EmployerNoteRepository: function EmployerNoteRepository() {
    return { findByEmployerId: noteFindByEmployerIdMock };
  },
  TopicRepository: function TopicRepository() {
    return { listForEmployer: topicListForEmployerMock };
  },
  EmployerTeamRepository: function EmployerTeamRepository() {
    return { listForEmployer: teamListForEmployerMock };
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
    expect(employerListMock).toHaveBeenCalledWith({ search: "Ghost Bank", limit: 5 });
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

    expect(findByEmployerIdMock).toHaveBeenCalledWith("emp-1");
    expect(listForEmployerMock).toHaveBeenCalledWith("emp-1");
    expect(result).toContain("## Evercore");
    expect(result).toContain("**Industry:** Investment Banking");
    expect(result).toContain("**Jane Doe** (primary) — Managing Director — jane@evercore.com");
    expect(result).toContain("**John Roe** — john@evercore.com");
    expect(result).toContain("Acme Corp (confidence: high)");
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
        subject: "Intro call follow-up",
        sent_at: "2026-06-01T09:00:00.000Z",
        direction: "inbound",
        from_display_name: "Jane Doe",
        from_address: "jane@evercore.com",
      },
      {
        subject: null,
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
    // Recent emails — direction, date, subject, sender.
    expect(result).toContain("### Recent emails");
    expect(result).toContain("2026-06-01 ↘ received — Intro call follow-up (from Jane Doe)");
    expect(result).toContain("2026-05-28 ↗ sent — (no subject)");
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
    expect(employerListMock).toHaveBeenCalledWith({ search: "anything", limit: 10 });
  });
});
