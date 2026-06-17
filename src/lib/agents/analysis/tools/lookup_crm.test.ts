import { afterEach, describe, expect, it, vi } from "vitest";

const employerListMock = vi.fn();
const findByEmployerIdMock = vi.fn();
const listForEmployerMock = vi.fn();

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
}));

import { lookupCrm } from "./lookup_crm";

afterEach(() => vi.clearAllMocks());

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
    findByEmployerIdMock.mockResolvedValue([]);
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

  it("notes when a firm has no bankers on record", async () => {
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
    findByEmployerIdMock.mockResolvedValue([]);
    listForEmployerMock.mockResolvedValue([]);

    const result = (await lookupCrm.invoke({ query: "Lonely" })) as string;
    expect(result).toContain("_No bankers/correspondents on record._");
    expect(result).toContain("_No linked pipeline companies on record._");
  });

  it("passes through an explicit in-range limit", async () => {
    employerListMock.mockResolvedValue([]);
    await lookupCrm.invoke({ query: "anything", limit: 10 });
    expect(employerListMock).toHaveBeenCalledWith({ search: "anything", limit: 10 });
  });
});
