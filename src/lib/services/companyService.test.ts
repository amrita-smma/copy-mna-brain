import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CompanyRepository,
  CompanyLogRepository,
  DealDocumentRepository,
  DealNoteRepository,
  DealLinkRepository,
  CompanyFinancialRepository,
  CompanyFxAdjustmentRepository,
  CompanyScreeningDerivedRepository,
  Tables,
} from "@/lib/repositories";
import { CompanyDroppedError, CompanyService } from "./companyService";

vi.mock("@/lib/s3", () => ({ deleteFile: vi.fn() }));

import { deleteFile } from "@/lib/s3";

afterEach(() => vi.clearAllMocks());

type Company = Tables<"companies">;

function makeCompany(overrides: Partial<Company> = {}): Company {
  return {
    id: "company-1",
    target: "Acme Corp",
    pipeline_stage: "L0",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Company;
}

function makeRepos() {
  const companyRepo = {
    // Default: every guard lookup returns an active company. Tests that
    // exercise the dropped-write guard override this with a dropped row.
    findById: vi.fn().mockResolvedValue(makeCompany()),
    findAll: vi.fn(),
    findIdAndTargetPage: vi.fn().mockResolvedValue([]),
    count: vi.fn(),
    findDetails: vi.fn(),
    insert: vi.fn(),
    update: vi.fn().mockResolvedValue([]),
    updateMany: vi.fn(),
    delete: vi.fn(),
    runL1Filters: vi.fn(),
    setAssignees: vi.fn().mockResolvedValue(undefined),
    findAssignees: vi.fn().mockResolvedValue([]),
    findAssigneesByCompanies: vi.fn().mockResolvedValue([]),
    findDroppedIds: vi.fn().mockResolvedValue([]),
  } as unknown as CompanyRepository;

  const companyLogRepo = {
    insert: vi.fn().mockResolvedValue(undefined),
    insertMany: vi.fn(),
  } as unknown as CompanyLogRepository;

  const dealDocRepo = {
    findFilePathsByDealId: vi.fn(),
    delete: vi.fn(),
  } as unknown as DealDocumentRepository;

  const dealNoteRepo = {
    insert: vi.fn().mockResolvedValue({}),
  } as unknown as DealNoteRepository;
  const dealLinkRepo = {
    insert: vi.fn().mockResolvedValue({}),
  } as unknown as DealLinkRepository;
  const companyFinancialRepo = {
    findByCompany: vi.fn().mockResolvedValue([]),
    findByCompanyAndYear: vi.fn().mockResolvedValue(null),
    findLatestByCompanies: vi.fn().mockResolvedValue([]),
    findByCompaniesAndYears: vi.fn().mockResolvedValue([]),
    findByCompanies: vi.fn().mockResolvedValue([]),
    upsert: vi.fn().mockResolvedValue(undefined),
    bulkUpsertForCompany: vi.fn().mockResolvedValue(undefined),
    deleteByCompanyAndYears: vi.fn().mockResolvedValue(undefined),
  } as unknown as CompanyFinancialRepository;
  const companyFxAdjustmentRepo = {
    findByCompany: vi.fn().mockResolvedValue([]),
    findByCompanies: vi.fn().mockResolvedValue([]),
    bulkUpsertForCompany: vi.fn().mockResolvedValue(undefined),
  } as unknown as CompanyFxAdjustmentRepository;
  const companyScreeningDerivedRepo = {
    findByCompany: vi.fn().mockResolvedValue(null),
    findByCompanies: vi.fn().mockResolvedValue([]),
    upsertByCompany: vi.fn().mockResolvedValue(undefined),
  } as unknown as CompanyScreeningDerivedRepository;

  return {
    companyRepo,
    companyLogRepo,
    dealDocRepo,
    dealNoteRepo,
    dealLinkRepo,
    companyFinancialRepo,
    companyFxAdjustmentRepo,
    companyScreeningDerivedRepo,
  };
}

function buildService(repos: ReturnType<typeof makeRepos>) {
  return new CompanyService(
    repos.companyRepo,
    repos.companyLogRepo,
    repos.dealDocRepo,
    repos.dealNoteRepo,
    repos.dealLinkRepo,
    repos.companyFinancialRepo,
    repos.companyFxAdjustmentRepo,
    repos.companyScreeningDerivedRepo,
  );
}

describe("CompanyService.create", () => {
  it("inserts a log when logAction is provided", async () => {
    const repos = makeRepos();
    const company = makeCompany();
    vi.mocked(repos.companyRepo.insert).mockResolvedValue(company);
    const service = buildService(repos);

    await service.create({ target: "Acme" } as any, "CREATED");

    expect(repos.companyLogRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ company_id: company.id, action: "CREATED" }),
    );
  });

  it("does not insert a log when logAction is omitted", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.insert).mockResolvedValue(makeCompany());
    const service = buildService(repos);

    await service.create({ target: "Acme" } as any);

    expect(repos.companyLogRepo.insert).not.toHaveBeenCalled();
  });
});

describe("CompanyService.delete", () => {
  it("deletes each S3 file before removing the DB record", async () => {
    const repos = makeRepos();
    vi.mocked(repos.dealDocRepo.findFilePathsByDealId).mockResolvedValue([
      "a/file.pdf",
      "b/file.pdf",
    ]);
    const service = buildService(repos);

    await service.delete("company-1");

    expect(deleteFile).toHaveBeenCalledTimes(2);
    expect(deleteFile).toHaveBeenCalledWith("a/file.pdf");
    expect(deleteFile).toHaveBeenCalledWith("b/file.pdf");
    expect(repos.companyRepo.delete).toHaveBeenCalledWith("company-1");
  });

  it("skips S3 deletion when there are no documents", async () => {
    const repos = makeRepos();
    vi.mocked(repos.dealDocRepo.findFilePathsByDealId).mockResolvedValue([]);
    const service = buildService(repos);

    await service.delete("company-1");

    expect(deleteFile).not.toHaveBeenCalled();
    expect(repos.companyRepo.delete).toHaveBeenCalledWith("company-1");
  });
});

describe("CompanyService.promote", () => {
  let repos: ReturnType<typeof makeRepos>;
  let service: CompanyService;

  beforeEach(() => {
    repos = makeRepos();
    service = buildService(repos);
    vi.mocked(repos.companyRepo.update).mockResolvedValue([makeCompany()]);
  });

  it("uses PROMOTED_FROM_X_TO_Y format when currentStage is provided", async () => {
    await service.promote("company-1", "L1", "L2");
    expect(repos.companyLogRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ action: "PROMOTED_FROM_L1_TO_L2" }),
    );
  });

  it("uses PROMOTED_TO_X format when currentStage is absent", async () => {
    await service.promote("company-1", undefined, "L1");
    expect(repos.companyLogRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ action: "PROMOTED_TO_L1" }),
    );
  });

  it("inserts a note when note is provided", async () => {
    await service.promote("company-1", "L1", "L2", "Some note");
    expect(repos.dealNoteRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Some note", deal_id: "company-1" }),
    );
  });

  it("does not insert a note when note is blank", async () => {
    await service.promote("company-1", "L1", "L2", "  ");
    expect(repos.dealNoteRepo.insert).not.toHaveBeenCalled();
  });

  it("inserts a link when linkUrl is provided", async () => {
    await service.promote(
      "company-1",
      "L1",
      "L2",
      undefined,
      "https://example.com",
      "Report",
    );
    expect(repos.dealLinkRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://example.com",
        title: "Report",
        deal_id: "company-1",
      }),
    );
  });

  it("does not insert a link when linkUrl is blank", async () => {
    await service.promote("company-1", "L1", "L2", undefined, "  ");
    expect(repos.dealLinkRepo.insert).not.toHaveBeenCalled();
  });
});

describe("CompanyService.promote (promotion reason)", () => {
  let repos: ReturnType<typeof makeRepos>;
  let service: CompanyService;

  beforeEach(() => {
    repos = makeRepos();
    service = buildService(repos);
    vi.mocked(repos.companyRepo.update).mockResolvedValue([makeCompany()]);
  });

  it("sets promoted_reasons to the trimmed text when the company has none yet", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ promoted_reasons: null }),
    );

    await service.promote(
      "company-1",
      "L0",
      "L1",
      undefined,
      undefined,
      undefined,
      undefined,
      "  - strong EBITDA growth  ",
    );

    expect(repos.companyRepo.update).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        pipeline_stage: "L1",
        promoted_reasons: "- strong EBITDA growth",
      }),
    );
  });

  it("appends the new block to existing promoted_reasons with a blank-line separator", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ promoted_reasons: "- first promotion" }),
    );

    await service.promote(
      "company-1",
      "L1",
      "L2",
      undefined,
      undefined,
      undefined,
      undefined,
      "- second promotion\n- with another bullet",
    );

    expect(repos.companyRepo.update).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        promoted_reasons:
          "- first promotion\n\n- second promotion\n- with another bullet",
      }),
    );
  });

  it("does not touch promoted_reasons when promotionReason is blank or absent", async () => {
    await service.promote("company-1", "L0", "L1");

    const updates = vi.mocked(repos.companyRepo.update).mock
      .calls[0][1] as Record<string, unknown>;
    expect(updates).not.toHaveProperty("promoted_reasons");
  });

  it("does not touch promoted_reasons when promotionReason is whitespace", async () => {
    await service.promote(
      "company-1",
      "L0",
      "L1",
      undefined,
      undefined,
      undefined,
      undefined,
      "   ",
    );

    const updates = vi.mocked(repos.companyRepo.update).mock
      .calls[0][1] as Record<string, unknown>;
    expect(updates).not.toHaveProperty("promoted_reasons");
  });
});

describe("CompanyService.promote (assignees)", () => {
  let repos: ReturnType<typeof makeRepos>;
  let service: CompanyService;

  beforeEach(() => {
    repos = makeRepos();
    service = buildService(repos);
  });

  it("replaces assignees when an array is supplied", async () => {
    await service.promote(
      "company-1",
      "L1",
      "L2",
      undefined,
      undefined,
      undefined,
      ["user-a", "user-b"],
    );

    expect(repos.companyRepo.setAssignees).toHaveBeenCalledWith("company-1", [
      "user-a",
      "user-b",
    ]);
  });

  it("clears assignees when an empty array is supplied", async () => {
    await service.promote(
      "company-2",
      "L1",
      "L2",
      undefined,
      undefined,
      undefined,
      [],
    );

    expect(repos.companyRepo.setAssignees).toHaveBeenCalledWith(
      "company-2",
      [],
    );
  });

  it("leaves assignees untouched when not supplied", async () => {
    await service.promote("company-3", "L1", "L2");

    expect(repos.companyRepo.setAssignees).not.toHaveBeenCalled();
  });
});

describe("CompanyService.dropDeal", () => {
  let repos: ReturnType<typeof makeRepos>;
  let service: CompanyService;

  beforeEach(() => {
    repos = makeRepos();
    service = buildService(repos);
  });

  it("marks the company as dropped and writes a stage-aware log entry", async () => {
    await service.dropDeal("company-1", "L2");

    expect(repos.companyRepo.update).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({
        status: "dropped",
        dropped_reason: null,
        dropped_at: expect.any(String),
      }),
    );
    expect(repos.companyLogRepo.insert).toHaveBeenCalledWith({
      company_id: "company-1",
      action: "DROPPED_FROM_L2",
    });
    expect(repos.dealNoteRepo.insert).not.toHaveBeenCalled();
  });

  it("falls back to a stageless log action when current stage is missing", async () => {
    await service.dropDeal("company-2", undefined);

    expect(repos.companyLogRepo.insert).toHaveBeenCalledWith({
      company_id: "company-2",
      action: "DROPPED",
    });
  });

  it("persists a deal note and trimmed dropped_reason when a non-blank reason is provided", async () => {
    await service.dropDeal("company-3", "L1", "  competitor acquired them  ");

    expect(repos.companyRepo.update).toHaveBeenCalledWith(
      "company-3",
      expect.objectContaining({
        status: "dropped",
        dropped_reason: "competitor acquired them",
        dropped_at: expect.any(String),
      }),
    );
    expect(repos.dealNoteRepo.insert).toHaveBeenCalledWith({
      deal_id: "company-3",
      content: "  competitor acquired them  ",
      stage: "L1",
    });
  });

  it("skips the deal note when the reason is blank or whitespace", async () => {
    await service.dropDeal("company-4", "L0", "   ");

    expect(repos.dealNoteRepo.insert).not.toHaveBeenCalled();
  });

  it("defaults the note stage to L0 when current stage is missing", async () => {
    await service.dropDeal("company-5", undefined, "no fit");

    expect(repos.dealNoteRepo.insert).toHaveBeenCalledWith({
      deal_id: "company-5",
      content: "no fit",
      stage: "L0",
    });
  });
});

describe("CompanyService.restoreDeal", () => {
  let repos: ReturnType<typeof makeRepos>;
  let service: CompanyService;

  beforeEach(() => {
    repos = makeRepos();
    service = buildService(repos);
  });

  it("clears the dropped status, dropped_reason, dropped_at and writes a stage-aware log entry", async () => {
    await service.restoreDeal("company-1", "L3");

    expect(repos.companyRepo.update).toHaveBeenCalledWith("company-1", {
      status: "active",
      dropped_reason: null,
      dropped_at: null,
    });
    expect(repos.companyLogRepo.insert).toHaveBeenCalledWith({
      company_id: "company-1",
      action: "RESTORED_TO_L3",
    });
    expect(repos.dealNoteRepo.insert).not.toHaveBeenCalled();
  });

  it("falls back to a stageless log action when current stage is missing", async () => {
    await service.restoreDeal("company-2", undefined);

    expect(repos.companyLogRepo.insert).toHaveBeenCalledWith({
      company_id: "company-2",
      action: "RESTORED",
    });
  });
});

describe("CompanyService.updateFinancials", () => {
  let repos: ReturnType<typeof makeRepos>;
  let service: CompanyService;

  beforeEach(() => {
    repos = makeRepos();
    service = buildService(repos);
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(makeCompany());
  });

  it("preserves untouched fields when only revenue is submitted", async () => {
    vi.mocked(repos.companyFinancialRepo.findByCompany).mockResolvedValue([
      {
        id: "fin-1",
        company_id: "company-1",
        fiscal_year: 2024,
        revenue_usd_mn: "100" as any,
        ebitda_usd_mn: "20" as any,
        ev_usd_mn: "500" as any,
        ebitda_margin: "0.2" as any,
        ev_ebitda: "25" as any,
        revenue_cagr_vs_prior: "0.1" as any,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);

    await service.updateFinancials(
      "company-1",
      [{ fiscal_year: 2024, revenue_usd_mn: 150 }],
      [],
    );

    expect(
      repos.companyFinancialRepo.bulkUpsertForCompany,
    ).toHaveBeenCalledWith(
      "company-1",
      expect.arrayContaining([
        expect.objectContaining({
          fiscal_year: 2024,
          revenue_usd_mn: 150,
          ebitda_usd_mn: "20",
          ev_usd_mn: "500",
          ebitda_margin: "0.2",
        }),
      ]),
    );
  });

  it("preserves existing ebitda when revenue-only row is submitted for a new year", async () => {
    vi.mocked(repos.companyFinancialRepo.findByCompany).mockResolvedValue([]);

    await service.updateFinancials(
      "company-1",
      [{ fiscal_year: 2025, revenue_usd_mn: 200 }],
      [],
    );

    expect(
      repos.companyFinancialRepo.bulkUpsertForCompany,
    ).toHaveBeenCalledWith(
      "company-1",
      expect.arrayContaining([
        expect.objectContaining({
          fiscal_year: 2025,
          revenue_usd_mn: 200,
          ebitda_usd_mn: null,
          ev_usd_mn: null,
        }),
      ]),
    );
  });

  it("calls deleteByCompanyAndYears when deletedYears are provided", async () => {
    vi.mocked(repos.companyFinancialRepo.findByCompany).mockResolvedValue([]);

    await service.updateFinancials("company-1", [], [2021]);

    expect(
      repos.companyFinancialRepo.deleteByCompanyAndYears,
    ).toHaveBeenCalledWith("company-1", [2021]);
    expect(
      repos.companyFinancialRepo.bulkUpsertForCompany,
    ).not.toHaveBeenCalled();
  });

  it("handles combined upsert and delete in one call", async () => {
    vi.mocked(repos.companyFinancialRepo.findByCompany).mockResolvedValue([]);

    await service.updateFinancials(
      "company-1",
      [{ fiscal_year: 2024, ebitda_usd_mn: 42 }],
      [2021],
    );

    expect(
      repos.companyFinancialRepo.bulkUpsertForCompany,
    ).toHaveBeenCalledWith(
      "company-1",
      expect.arrayContaining([
        expect.objectContaining({ fiscal_year: 2024, ebitda_usd_mn: 42 }),
      ]),
    );
    expect(
      repos.companyFinancialRepo.deleteByCompanyAndYears,
    ).toHaveBeenCalledWith("company-1", [2021]);
  });

  it("writes a log entry when logAction is provided", async () => {
    vi.mocked(repos.companyFinancialRepo.findByCompany).mockResolvedValue([]);

    await service.updateFinancials("company-1", [], [], "UPDATED_FINANCIALS");

    expect(repos.companyLogRepo.insert).toHaveBeenCalledWith({
      company_id: "company-1",
      action: "UPDATED_FINANCIALS",
    });
  });

  it("skips log when logAction is omitted", async () => {
    vi.mocked(repos.companyFinancialRepo.findByCompany).mockResolvedValue([]);

    await service.updateFinancials("company-1", [], []);

    expect(repos.companyLogRepo.insert).not.toHaveBeenCalled();
  });
});

describe("CompanyService.listIdAndTargetPage", () => {
  it("forwards limit, offset, and targetSearch to the repository", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.findIdAndTargetPage).mockResolvedValue([
      { id: "company-1", target: "Acme Corp", project_name: "Project Phoenix" },
    ]);
    const service = buildService(repos);

    const result = await service.listIdAndTargetPage({
      limit: 25,
      offset: 50,
      targetSearch: "acm",
    });

    expect(repos.companyRepo.findIdAndTargetPage).toHaveBeenCalledWith({
      limit: 25,
      offset: 50,
      targetSearch: "acm",
    });
    expect(result).toEqual([
      { id: "company-1", target: "Acme Corp", project_name: "Project Phoenix" },
    ]);
  });

  it("passes through with no filters when none are provided", async () => {
    const repos = makeRepos();
    const service = buildService(repos);

    await service.listIdAndTargetPage({});

    expect(repos.companyRepo.findIdAndTargetPage).toHaveBeenCalledWith({});
  });
});

describe("CompanyService dropped-company write guard", () => {
  let repos: ReturnType<typeof makeRepos>;
  let service: CompanyService;

  beforeEach(() => {
    repos = makeRepos();
    service = buildService(repos);
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ status: "dropped" }),
    );
  });

  it("update throws CompanyDroppedError and does not touch the row", async () => {
    await expect(
      service.update("company-1", { target: "Renamed" } as any),
    ).rejects.toBeInstanceOf(CompanyDroppedError);
    expect(repos.companyRepo.update).not.toHaveBeenCalled();
    expect(repos.companyLogRepo.insert).not.toHaveBeenCalled();
  });

  it("updateFromDTO throws and skips both company + child writes", async () => {
    await expect(
      service.updateFromDTO("company-1", { target: "Renamed" } as any),
    ).rejects.toBeInstanceOf(CompanyDroppedError);
    expect(repos.companyRepo.update).not.toHaveBeenCalled();
    expect(
      repos.companyFinancialRepo.bulkUpsertForCompany,
    ).not.toHaveBeenCalled();
  });

  it("updateMany throws and lists every dropped id in the error", async () => {
    vi.mocked(repos.companyRepo.findDroppedIds).mockResolvedValue([
      "company-1",
      "company-2",
    ]);

    await expect(
      service.updateMany(["company-1", "company-2", "company-3"], {
        target: "x",
      } as any),
    ).rejects.toMatchObject({
      name: "CompanyDroppedError",
      droppedIds: ["company-1", "company-2"],
    });
    expect(repos.companyRepo.updateMany).not.toHaveBeenCalled();
  });

  it("updateMany still writes when none of the ids are dropped", async () => {
    vi.mocked(repos.companyRepo.findDroppedIds).mockResolvedValue([]);
    vi.mocked(repos.companyRepo.updateMany).mockResolvedValue([]);

    await service.updateMany(["company-1", "company-2"], {
      target: "x",
    } as any);

    expect(repos.companyRepo.updateMany).toHaveBeenCalledWith(
      ["company-1", "company-2"],
      { target: "x" },
    );
  });

  it("promote throws and never advances pipeline_stage", async () => {
    await expect(
      service.promote("company-1", "L0", "L1"),
    ).rejects.toBeInstanceOf(CompanyDroppedError);
    expect(repos.companyRepo.update).not.toHaveBeenCalled();
    expect(repos.companyLogRepo.insert).not.toHaveBeenCalled();
  });

  it("setAssignees throws and does not mutate assignees", async () => {
    await expect(
      service.setAssignees("company-1", ["user-a"]),
    ).rejects.toBeInstanceOf(CompanyDroppedError);
    expect(repos.companyRepo.setAssignees).not.toHaveBeenCalled();
  });

  it("updateFinancials throws and skips financials writes", async () => {
    await expect(
      service.updateFinancials(
        "company-1",
        [{ fiscal_year: 2024, revenue_usd_mn: 1 }],
        [],
      ),
    ).rejects.toBeInstanceOf(CompanyDroppedError);
    expect(
      repos.companyFinancialRepo.bulkUpsertForCompany,
    ).not.toHaveBeenCalled();
    expect(
      repos.companyFinancialRepo.deleteByCompanyAndYears,
    ).not.toHaveBeenCalled();
  });

  it("restoreDeal still works on a dropped company (escape hatch)", async () => {
    vi.mocked(repos.companyRepo.update).mockResolvedValue([
      makeCompany({ status: "active" }),
    ]);

    await service.restoreDeal("company-1", "L1");

    expect(repos.companyRepo.update).toHaveBeenCalledWith("company-1", {
      status: "active",
      dropped_reason: null,
      dropped_at: null,
    });
  });
});
