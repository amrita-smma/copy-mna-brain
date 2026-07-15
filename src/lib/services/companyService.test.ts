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
  FileRepository,
  Tables,
} from "@/lib/repositories";
import { CompanyDroppedError, CompanyL0RequirementsError, CompanyService } from "./companyService";

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
    findByNameFuzzy: vi.fn().mockResolvedValue(null),
    findAllIdAndTarget: vi.fn().mockResolvedValue([]),
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
    insertMany: vi.fn().mockResolvedValue(undefined),
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

  const fileRepo = {
    removeMatchedCompany: vi.fn().mockResolvedValue(undefined),
  } as unknown as FileRepository;

  return {
    companyRepo,
    companyLogRepo,
    dealDocRepo,
    dealNoteRepo,
    dealLinkRepo,
    companyFinancialRepo,
    companyFxAdjustmentRepo,
    companyScreeningDerivedRepo,
    fileRepo,
  };
}

function makeTrackMatchingService() {
  return { dispatch: vi.fn().mockResolvedValue({ jobId: 'job-1' }) };
}

function buildService(
  repos: ReturnType<typeof makeRepos>,
  trackMatchingService?: ReturnType<typeof makeTrackMatchingService>,
) {
  return new CompanyService(
    repos.companyRepo,
    repos.companyLogRepo,
    repos.dealDocRepo,
    repos.dealNoteRepo,
    repos.dealLinkRepo,
    repos.companyFinancialRepo,
    repos.companyFxAdjustmentRepo,
    repos.companyScreeningDerivedRepo,
    trackMatchingService as never,
    undefined,
    repos.fileRepo,
  );
}

describe("CompanyService.findBestFuzzyMatch", () => {
  it("returns null without hitting the DB for names shorter than 5 chars", async () => {
    const repos = makeRepos();
    const service = buildService(repos);

    const result = await service.findBestFuzzyMatch("SEB");

    expect(result).toBeNull();
    expect(repos.companyRepo.findAllIdAndTarget).not.toHaveBeenCalled();
  });

  it("resolves a Levenshtein match to the full company row", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.findAllIdAndTarget).mockResolvedValue([
      { id: "company-1", target: "Acme Corp", project_name: null },
    ]);
    const matched = makeCompany({ id: "company-1", target: "Acme Corp" });
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(matched);
    const service = buildService(repos);

    // "Acme Crop" is a one-transposition typo of "Acme Corp".
    const result = await service.findBestFuzzyMatch("Acme Crop");

    expect(repos.companyRepo.findById).toHaveBeenCalledWith("company-1");
    expect(result).toBe(matched);
  });

  it("returns null when no candidate clears the similarity threshold", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.findAllIdAndTarget).mockResolvedValue([
      { id: "company-1", target: "Acme Corp", project_name: null },
    ]);
    const service = buildService(repos);

    const result = await service.findBestFuzzyMatch("Totally Different Name");

    expect(result).toBeNull();
    expect(repos.companyRepo.findById).not.toHaveBeenCalled();
  });
});

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

describe("CompanyService.createFromDTO", () => {
  it("requires either target or project_name", async () => {
    const repos = makeRepos();
    const service = buildService(repos);

    await expect(
      service.createFromDTO({ target: " ", project_name: "" } as any),
    ).rejects.toThrow("Company requires either target or project_name.");
    expect(repos.companyRepo.insert).not.toHaveBeenCalled();
  });

  it("allows project-only company creation", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.insert).mockResolvedValue(
      makeCompany({ target: null, project_name: "Project Falcon" }),
    );
    const service = buildService(repos);

    await service.createFromDTO({ project_name: "Project Falcon" } as any);

    expect(repos.companyRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ project_name: "Project Falcon" }),
    );
  });
});

describe("CompanyService.delete", () => {
  it("removes the DB record without deleting the underlying files", async () => {
    const repos = makeRepos();
    vi.mocked(repos.dealDocRepo.findFilePathsByDealId).mockResolvedValue([
      "a/file.pdf",
      "b/file.pdf",
    ]);
    const service = buildService(repos);

    await service.delete("company-1");

    // Files are intentionally left in storage — we only drop the DB reference.
    expect(deleteFile).not.toHaveBeenCalled();
    expect(repos.companyRepo.delete).toHaveBeenCalledWith("company-1");
  });

  it("strips the company from files' matched_companies before removing the DB record", async () => {
    const repos = makeRepos();
    vi.mocked(repos.dealDocRepo.findFilePathsByDealId).mockResolvedValue([]);
    const service = buildService(repos);

    await service.delete("company-1");

    expect(repos.fileRepo.removeMatchedCompany).toHaveBeenCalledWith("company-1");
    expect(repos.fileRepo.removeMatchedCompany).toHaveBeenCalledTimes(1);
    expect(repos.companyRepo.delete).toHaveBeenCalledWith("company-1");
  });

  it("does not throw when no fileRepo is wired in", async () => {
    const repos = makeRepos();
    vi.mocked(repos.dealDocRepo.findFilePathsByDealId).mockResolvedValue([]);
    const service = new CompanyService(
      repos.companyRepo,
      repos.companyLogRepo,
      repos.dealDocRepo,
      repos.dealNoteRepo,
      repos.dealLinkRepo,
      repos.companyFinancialRepo,
      repos.companyFxAdjustmentRepo,
      repos.companyScreeningDerivedRepo,
    );

    await expect(service.delete("company-1")).resolves.toBeUndefined();
    expect(repos.companyRepo.delete).toHaveBeenCalledWith("company-1");
  });
});

describe("CompanyService — track matching on L0 entry", () => {
  it("dispatches track matching when a company is created at L0", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.insert).mockResolvedValue(
      makeCompany({ id: "c-new", pipeline_stage: "L0" }),
    );
    const trackMatching = makeTrackMatchingService();
    const service = buildService(repos, trackMatching);

    await service.createFromDTO({ target: "Acme" } as any);

    expect(trackMatching.dispatch).toHaveBeenCalledWith({ companyId: "c-new" });
  });

  it("does NOT dispatch when a company is created at a non-L0 stage", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.insert).mockResolvedValue(
      makeCompany({ id: "c-mkt", pipeline_stage: "market_screening" }),
    );
    const trackMatching = makeTrackMatchingService();
    const service = buildService(repos, trackMatching);

    await service.createFromDTO({ target: "Acme" } as any);

    expect(trackMatching.dispatch).not.toHaveBeenCalled();
  });

  it("runs sync track matching when a company is promoted to L0 from a pre-L0 stage with no track", async () => {
    const repos = makeRepos();
    const trackMatching = { dispatch: vi.fn(), runSync: vi.fn().mockResolvedValue({ matchedTrackIds: [] }) };
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({
        pipeline_stage: "market_screening",
        entered_by: "John",
        source: "inbound",
        deal_type: "majority",
        geography: "Indonesia",
        segment: "Technology",
        banker: "Goldman",
        matched_track_ids: [],
      }),
    );
    const service = buildService(repos, trackMatching as never);

    await service.promote("company-1", "market_screening", "L0");

    expect(trackMatching.runSync).toHaveBeenCalledWith({ companyId: "company-1" });
    expect(trackMatching.dispatch).not.toHaveBeenCalled();
  });

  it("does NOT dispatch when a company is demoted into L0 from L1", async () => {
    const repos = makeRepos();
    const trackMatching = makeTrackMatchingService();
    const service = buildService(repos, trackMatching);

    await service.promote("company-1", "L1", "L0");

    expect(trackMatching.dispatch).not.toHaveBeenCalled();
  });

  it("does NOT dispatch when promoting to a non-L0 stage", async () => {
    const repos = makeRepos();
    const trackMatching = makeTrackMatchingService();
    const service = buildService(repos, trackMatching);

    await service.promote("company-1", "L1", "L2");

    expect(trackMatching.dispatch).not.toHaveBeenCalled();
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

  it("copies Deal Sponsor into Deal Captain on promotion into L3 when captain is empty", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ deal_sponsor: "5f0e3f9a-1111-4222-8333-444455556666", deal_captain: null }),
    );
    await service.promote("company-1", "L2", "L3");
    expect(repos.companyRepo.update).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ pipeline_stage: "L3", deal_captain: "5f0e3f9a-1111-4222-8333-444455556666" }),
    );
  });

  it("does not overwrite an existing Deal Captain on promotion into L3+", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ deal_sponsor: "5f0e3f9a-1111-4222-8333-444455556666", deal_captain: "6a1f4a0b-2222-4333-9444-555566667777" }),
    );
    await service.promote("company-1", "L2", "L3");
    const updates = vi.mocked(repos.companyRepo.update).mock.calls[0][1];
    expect(updates).not.toHaveProperty("deal_captain");
  });

  it("does not set Deal Captain when promoting within L0–L2", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ deal_sponsor: "5f0e3f9a-1111-4222-8333-444455556666", deal_captain: null }),
    );
    await service.promote("company-1", "L1", "L2");
    const updates = vi.mocked(repos.companyRepo.update).mock.calls[0][1];
    expect(updates).not.toHaveProperty("deal_captain");
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

  it("clears resurface_at and dropped_by when no scheduling options are provided", async () => {
    await service.dropDeal("company-6", "L1");

    expect(repos.companyRepo.update).toHaveBeenCalledWith(
      "company-6",
      expect.objectContaining({ resurface_at: null, dropped_by: null }),
    );
  });

  it("persists a future resurface_at and the dropping user", async () => {
    const future = new Date(Date.now() + 30 * 86400000).toISOString();

    await service.dropDeal("company-7", "L1", "timing", {
      resurfaceAt: future,
      droppedBy: "user-1",
    });

    expect(repos.companyRepo.update).toHaveBeenCalledWith(
      "company-7",
      expect.objectContaining({
        status: "dropped",
        resurface_at: future,
        dropped_by: "user-1",
      }),
    );
  });

  it("rejects a resurface date in the past without touching the DB", async () => {
    await expect(
      service.dropDeal("company-8", "L1", undefined, {
        resurfaceAt: "2020-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("Resurface date must be in the future");

    expect(repos.companyRepo.update).not.toHaveBeenCalled();
  });

  it("rejects an unparsable resurface date without touching the DB", async () => {
    await expect(
      service.dropDeal("company-9", "L1", undefined, {
        resurfaceAt: "not-a-date",
      }),
    ).rejects.toThrow("Invalid resurface date");

    expect(repos.companyRepo.update).not.toHaveBeenCalled();
  });
});

describe("CompanyService.dropDealMany", () => {
  let repos: ReturnType<typeof makeRepos>;
  let service: CompanyService;

  beforeEach(() => {
    repos = makeRepos();
    service = buildService(repos);
  });

  it('returns without writing when the deals list is empty', async () => {
    await service.dropDealMany([], 'noop');

    expect(repos.companyRepo.findDroppedIds).not.toHaveBeenCalled();
    expect(repos.companyRepo.updateMany).not.toHaveBeenCalled();
    expect(repos.companyLogRepo.insertMany).not.toHaveBeenCalled();
    expect(repos.dealNoteRepo.insertMany).not.toHaveBeenCalled();
  });

  it('drops all companies in one updateMany call and writes per-company stage logs', async () => {
    await service.dropDealMany([
      { id: 'company-1', currentStage: 'L2' },
      { id: 'company-2', currentStage: 'L0' },
    ]);

    expect(repos.companyRepo.updateMany).toHaveBeenCalledWith(
      ['company-1', 'company-2'],
      expect.objectContaining({
        status: 'dropped',
        dropped_reason: null,
        dropped_at: expect.any(String),
      }),
    );
    expect(repos.companyLogRepo.insertMany).toHaveBeenCalledWith([
      { company_id: 'company-1', action: 'DROPPED_FROM_L2' },
      { company_id: 'company-2', action: 'DROPPED_FROM_L0' },
    ]);
    expect(repos.dealNoteRepo.insertMany).not.toHaveBeenCalled();
  });

  it('falls back to DROPPED when a company has no current stage', async () => {
    await service.dropDealMany([
      { id: 'company-1', currentStage: 'L1' },
      { id: 'company-2' },
    ]);

    expect(repos.companyLogRepo.insertMany).toHaveBeenCalledWith([
      { company_id: 'company-1', action: 'DROPPED_FROM_L1' },
      { company_id: 'company-2', action: 'DROPPED' },
    ]);
  });

  it('persists trimmed reason on companies and inserts one note per id with per-company stage', async () => {
    await service.dropDealMany(
      [
        { id: 'company-1', currentStage: 'L2' },
        { id: 'company-2' },
      ],
      '  no fit  ',
    );

    expect(repos.companyRepo.updateMany).toHaveBeenCalledWith(
      ['company-1', 'company-2'],
      expect.objectContaining({
        dropped_reason: 'no fit',
      }),
    );
    expect(repos.dealNoteRepo.insertMany).toHaveBeenCalledWith([
      { deal_id: 'company-1', content: 'no fit', stage: 'L2' },
      { deal_id: 'company-2', content: 'no fit', stage: 'L0' },
    ]);
  });

  it('skips note insert when reason is blank or whitespace', async () => {
    await service.dropDealMany(
      [{ id: 'company-1', currentStage: 'L2' }],
      '   ',
    );

    expect(repos.dealNoteRepo.insertMany).not.toHaveBeenCalled();
  });

  it('succeeds idempotently and writes to DB even when an id is already dropped', async () => {
    vi.mocked(repos.companyRepo.findDroppedIds).mockResolvedValue(['company-2']);

    await service.dropDealMany([
      { id: 'company-1', currentStage: 'L1' },
      { id: 'company-2', currentStage: 'L1' },
    ]);

    expect(repos.companyRepo.updateMany).toHaveBeenCalled();
    expect(repos.companyLogRepo.insertMany).toHaveBeenCalled();
  });
});

describe('CompanyService.promoteMany', () => {
  let repos: ReturnType<typeof makeRepos>;
  let service: CompanyService;

  beforeEach(() => {
    repos = makeRepos();
    service = buildService(repos);
  });

  it('returns without writing when the deals list is empty', async () => {
    await service.promoteMany([], 'L1');
    expect(repos.companyRepo.findDroppedIds).not.toHaveBeenCalled();
    expect(repos.companyRepo.updateMany).not.toHaveBeenCalled();
    expect(repos.companyLogRepo.insertMany).not.toHaveBeenCalled();
  });

  it('updates pipeline_stage in one updateMany call and writes per-company stage logs', async () => {
    await service.promoteMany(
      [
        { id: 'c-1', currentStage: 'L0' },
        { id: 'c-2', currentStage: 'L0' },
      ],
      'L1',
    );

    expect(repos.companyRepo.findDroppedIds).toHaveBeenCalledWith(['c-1', 'c-2']);
    expect(repos.companyRepo.updateMany).toHaveBeenCalledWith(
      ['c-1', 'c-2'],
      { pipeline_stage: 'L1' },
    );
    expect(repos.companyLogRepo.insertMany).toHaveBeenCalledWith([
      { company_id: 'c-1', action: 'PROMOTED_FROM_L0_TO_L1' },
      { company_id: 'c-2', action: 'PROMOTED_FROM_L0_TO_L1' },
    ]);
  });

  it('falls back to stageless log action when a company has no current stage', async () => {
    await service.promoteMany(
      [{ id: 'c-1' }, { id: 'c-2', currentStage: 'L0' }],
      'L1',
    );

    expect(repos.companyLogRepo.insertMany).toHaveBeenCalledWith([
      { company_id: 'c-1', action: 'PROMOTED_TO_L1' },
      { company_id: 'c-2', action: 'PROMOTED_FROM_L0_TO_L1' },
    ]);
  });

  it('throws CompanyDroppedError and writes nothing when any id is already dropped', async () => {
    vi.mocked(repos.companyRepo.findDroppedIds).mockResolvedValue(['c-2']);

    await expect(
      service.promoteMany(
        [
          { id: 'c-1', currentStage: 'L0' },
          { id: 'c-2', currentStage: 'L0' },
        ],
        'L1',
      ),
    ).rejects.toMatchObject({
      name: 'CompanyDroppedError',
      droppedIds: ['c-2'],
    });
    expect(repos.companyRepo.updateMany).not.toHaveBeenCalled();
    expect(repos.companyLogRepo.insertMany).not.toHaveBeenCalled();
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
      resurface_at: null,
      dropped_by: null,
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

describe("CompanyService dropped-company writes", () => {
  let repos: ReturnType<typeof makeRepos>;
  let service: CompanyService;

  beforeEach(() => {
    repos = makeRepos();
    service = buildService(repos);
    // Every guard/DTO lookup resolves a dropped company so these tests
    // exercise the dropped path specifically.
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ status: "dropped" }),
    );
    vi.mocked(repos.companyRepo.findDroppedIds).mockResolvedValue([
      "company-1",
    ]);
  });

  it("update edits detail fields on a dropped company", async () => {
    vi.mocked(repos.companyRepo.update).mockResolvedValue([
      makeCompany({ status: "dropped", target: "Renamed" }),
    ]);

    await service.update("company-1", { target: "Renamed" } as any, "EDITED");

    expect(repos.companyRepo.update).toHaveBeenCalledWith("company-1", {
      target: "Renamed",
    });
    expect(repos.companyLogRepo.insert).toHaveBeenCalledWith({
      company_id: "company-1",
      action: "EDITED",
    });
  });

  it("updateFromDTO writes company + child fields on a dropped company", async () => {
    await service.updateFromDTO("company-1", { target: "Renamed" } as any);

    expect(repos.companyRepo.update).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ target: "Renamed" }),
    );
  });

  it("updateMany writes even when the ids are dropped", async () => {
    vi.mocked(repos.companyRepo.updateMany).mockResolvedValue([]);

    await service.updateMany(["company-1", "company-2"], {
      target: "x",
    } as any);

    expect(repos.companyRepo.updateMany).toHaveBeenCalledWith(
      ["company-1", "company-2"],
      { target: "x" },
    );
  });

  it("setAssignees mutates assignees on a dropped company", async () => {
    await service.setAssignees("company-1", ["user-a"]);

    expect(repos.companyRepo.setAssignees).toHaveBeenCalledWith("company-1", [
      "user-a",
    ]);
  });

  it("updateFinancials writes financials on a dropped company", async () => {
    await service.updateFinancials(
      "company-1",
      [{ fiscal_year: 2024, revenue_usd_mn: 1 }],
      [],
    );

    expect(repos.companyFinancialRepo.bulkUpsertForCompany).toHaveBeenCalled();
  });

  it("promote still throws and never advances pipeline_stage", async () => {
    await expect(
      service.promote("company-1", "L0", "L1"),
    ).rejects.toBeInstanceOf(CompanyDroppedError);
    expect(repos.companyRepo.update).not.toHaveBeenCalled();
    expect(repos.companyLogRepo.insert).not.toHaveBeenCalled();
  });

  it("promoteMany still throws and lists every dropped id in the error", async () => {
    vi.mocked(repos.companyRepo.findDroppedIds).mockResolvedValue([
      "company-1",
      "company-2",
    ]);

    await expect(
      service.promoteMany(
        [{ id: "company-1" }, { id: "company-2" }, { id: "company-3" }],
        "L1",
      ),
    ).rejects.toMatchObject({
      name: "CompanyDroppedError",
      droppedIds: ["company-1", "company-2"],
    });
    expect(repos.companyRepo.updateMany).not.toHaveBeenCalled();
  });

  it("dropDealMany succeeds idempotently even when an id is already dropped", async () => {
    await service.dropDealMany([{ id: "company-1" }]);
    expect(repos.companyRepo.updateMany).toHaveBeenCalled();
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
      resurface_at: null,
      dropped_by: null,
    });
  });
});

// Graph mirroring moved to the repository layer (CompanyRepository writes
// through to Neo4j on every operation); see companyRepository.test.ts.

const l0BaseCompany = makeCompany({
  pipeline_stage: "market_screening",
  status: "active",
  target: "Acme Corp",
  project_name: null,
  entered_by: "John Smith",
  source: "inbound",
  deal_type: "majority",
  geography: "Indonesia",
  segment: "Technology",
  banker: "Goldman",
  matched_track_ids: ["track-1"],
});

describe("CompanyService.promote — L0 requirements guard", () => {
  let repos: ReturnType<typeof makeRepos>;
  let service: CompanyService;
  const trackSvc = { dispatch: vi.fn(), runSync: vi.fn().mockResolvedValue({ matchedTrackIds: [] }) };

  beforeEach(() => {
    repos = makeRepos();
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(l0BaseCompany);
    service = buildService(repos, trackSvc as never);
  });

  it("promotes to L0 when all required fields are present", async () => {
    await expect(service.promote("company-1", "market_screening", "L0")).resolves.toBeUndefined();
    expect(repos.companyRepo.update).toHaveBeenCalledWith("company-1", expect.objectContaining({ pipeline_stage: "L0" }));
  });

  it("throws CompanyL0RequirementsError listing all missing fields", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ pipeline_stage: "market_screening", entered_by: null, geography: null, banker: null }),
    );
    await expect(service.promote("company-1", "market_screening", "L0")).rejects.toThrow(CompanyL0RequirementsError);
    await expect(service.promote("company-1", "market_screening", "L0")).rejects.toMatchObject({
      missingFields: expect.arrayContaining(["Entered By", "Geo", "Banker"]),
    });
  });

  it("rejects whitespace-only entered_by", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ ...l0BaseCompany, entered_by: "   " }),
    );
    await expect(service.promote("company-1", "market_screening", "L0")).rejects.toMatchObject({
      missingFields: expect.arrayContaining(["Entered By"]),
    });
  });

  it("rejects when neither target nor project_name is set", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ ...l0BaseCompany, target: null, project_name: null }),
    );
    await expect(service.promote("company-1", "market_screening", "L0")).rejects.toMatchObject({
      missingFields: expect.arrayContaining(["Company Name / Project Name"]),
    });
  });

  it("accepts project_name alone when target is null", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ ...l0BaseCompany, target: null, project_name: "Project Phoenix" }),
    );
    await expect(service.promote("company-1", "market_screening", "L0")).resolves.toBeUndefined();
  });

  it("runs sync track matching when matched_track_ids is empty", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ ...l0BaseCompany, matched_track_ids: [] }),
    );
    await service.promote("company-1", "market_screening", "L0");
    expect(trackSvc.runSync).toHaveBeenCalledWith({ companyId: "company-1" });
  });

  it("skips sync matching when tracks are already assigned", async () => {
    trackSvc.runSync.mockClear();
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ ...l0BaseCompany, matched_track_ids: ["track-1"] }),
    );
    await service.promote("company-1", "market_screening", "L0");
    expect(trackSvc.runSync).not.toHaveBeenCalled();
  });

  it("does NOT validate when promoting within L1+ (L1 → L2)", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ pipeline_stage: "L1", entered_by: null, geography: null }),
    );
    await expect(service.promote("company-1", "L1", "L2")).resolves.toBeUndefined();
  });

  it("does NOT validate when demoting back to L0 from L1+", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ pipeline_stage: "L1", entered_by: null, geography: null }),
    );
    await expect(service.promote("company-1", "L1", "L0")).resolves.toBeUndefined();
  });

  it("validates when promoting from unreviewed → L0 (the Keep flow)", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ pipeline_stage: "unreviewed", entered_by: null, geography: null }),
    );
    await expect(service.promote("company-1", "unreviewed", "L0")).rejects.toBeInstanceOf(CompanyL0RequirementsError);
  });

  it("accepts banker_source as a fallback for the Banker requirement", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ ...l0BaseCompany, pipeline_stage: "unreviewed", banker: null, banker_source: "Goldman Sachs" }),
    );
    await expect(service.promote("company-1", "unreviewed", "L0")).resolves.toBeUndefined();
  });

  it("outbound company with no banker promotes to L0 without error", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ ...l0BaseCompany, pipeline_stage: "unreviewed", source: "outbound", banker: null, banker_source: null }),
    );
    await expect(service.promote("company-1", "unreviewed", "L0")).resolves.toBeUndefined();
  });

  it("inbound company with no banker is still blocked", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ ...l0BaseCompany, pipeline_stage: "unreviewed", source: "inbound", banker: null, banker_source: null }),
    );
    await expect(service.promote("company-1", "unreviewed", "L0")).rejects.toMatchObject({
      missingFields: expect.arrayContaining(["Banker"]),
    });
  });
});

describe("CompanyService.updateFromDTO — L0 requirements guard on stage change", () => {
  let repos: ReturnType<typeof makeRepos>;
  let service: CompanyService;

  beforeEach(() => {
    repos = makeRepos();
    service = buildService(repos);
  });

  it("throws CompanyL0RequirementsError moving pre-L0 → L0 with missing fields", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ ...l0BaseCompany, pipeline_stage: "unreviewed", entered_by: null, geography: null, banker: null }),
    );
    await expect(service.updateFromDTO("company-1", { pipeline_stage: "L0" } as never)).rejects.toMatchObject({
      missingFields: expect.arrayContaining(["Entered By", "Geo", "Banker"]),
    });
  });

  it("does not write to the row when the guard rejects", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ ...l0BaseCompany, pipeline_stage: "unreviewed", entered_by: null }),
    );
    await expect(service.updateFromDTO("company-1", { pipeline_stage: "L0" } as never)).rejects.toBeInstanceOf(
      CompanyL0RequirementsError,
    );
    expect(repos.companyRepo.update).not.toHaveBeenCalled();
  });

  it("passes when the missing field is supplied in the same save", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ ...l0BaseCompany, pipeline_stage: "unreviewed", entered_by: null }),
    );
    await expect(
      service.updateFromDTO("company-1", { pipeline_stage: "L0", entered_by: "user-uuid" } as never),
    ).resolves.toBeDefined();
    expect(repos.companyRepo.update).toHaveBeenCalled();
  });

  it("validates entering the pipeline at L1 directly (stricter than promote)", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ ...l0BaseCompany, pipeline_stage: "market_screening", entered_by: null }),
    );
    await expect(service.updateFromDTO("company-1", { pipeline_stage: "L1" } as never)).rejects.toBeInstanceOf(
      CompanyL0RequirementsError,
    );
  });

  it("does not validate when the company is already in the pipeline (L1 edit)", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ pipeline_stage: "L1", entered_by: null, geography: null, banker: null }),
    );
    await expect(service.updateFromDTO("company-1", { pipeline_stage: "L1" } as never)).resolves.toBeDefined();
  });

  it("does not validate when the stage is not being changed", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ pipeline_stage: "unreviewed", entered_by: null, geography: null }),
    );
    await expect(service.updateFromDTO("company-1", { remarks: "note" } as never)).resolves.toBeDefined();
  });
});

describe("CompanyService.checkL0Requirements", () => {
  it("returns empty array when all fields present (inbound)", () => {
    expect(CompanyService.checkL0Requirements({
      target: "Acme Corp",
      entered_by: "user-uuid",
      source: "inbound",
      deal_type: "majority",
      geography: "Indonesia",
      segment: "Technology",
      banker: "Goldman Sachs",
    })).toEqual([]);
  });

  it("returns empty array for outbound without banker", () => {
    expect(CompanyService.checkL0Requirements({
      target: "Acme Corp",
      entered_by: "user-uuid",
      source: "outbound",
      deal_type: "majority",
      geography: "Indonesia",
      segment: "Technology",
      banker: null,
      banker_source: null,
    })).toEqual([]);
  });

  it("flags Banker for inbound without banker or banker_source", () => {
    const missing = CompanyService.checkL0Requirements({
      target: "Acme Corp",
      entered_by: "user-uuid",
      source: "inbound",
      deal_type: "majority",
      geography: "Indonesia",
      segment: "Technology",
      banker: null,
      banker_source: null,
    });
    expect(missing).toContain("Banker");
  });

  it("collects all missing fields when empty", () => {
    const missing = CompanyService.checkL0Requirements({});
    expect(missing).toEqual(expect.arrayContaining([
      "Company Name / Project Name",
      "Entered By",
      "Deal Type: Inbound/Outbound",
      "Deal Type: Majority/Minority",
      "Geo",
      "Sector",
    ]));
  });
});

describe("CompanyService user-name resolution (entered_by / deal_sponsor / deal_captain)", () => {
  const ENTERED_BY = "11111111-1111-4111-8111-111111111111";
  const SPONSOR = "22222222-2222-4222-8222-222222222222";
  const CAPTAIN = "33333333-3333-4333-8333-333333333333";

  function buildServiceWithUsers(repos: ReturnType<typeof makeRepos>, findByIds: ReturnType<typeof vi.fn>) {
    return new CompanyService(
      repos.companyRepo,
      repos.companyLogRepo,
      repos.dealDocRepo,
      repos.dealNoteRepo,
      repos.dealLinkRepo,
      repos.companyFinancialRepo,
      repos.companyFxAdjustmentRepo,
      repos.companyScreeningDerivedRepo,
      undefined,
      { findByIds } as never,
    );
  }

  it("findByIdDTO resolves all three uuid columns to names in one batch", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ entered_by: ENTERED_BY, deal_sponsor: SPONSOR, deal_captain: CAPTAIN }),
    );
    const findByIds = vi.fn().mockResolvedValue([
      { id: ENTERED_BY, name: "Enterer" },
      { id: SPONSOR, name: "Sponsor Sally" },
      { id: CAPTAIN, name: "Captain Carl" },
    ]);
    const service = buildServiceWithUsers(repos, findByIds);

    const dto = await service.findByIdDTO("company-1");

    expect(findByIds).toHaveBeenCalledTimes(1);
    expect(findByIds).toHaveBeenCalledWith(
      expect.arrayContaining([ENTERED_BY, SPONSOR, CAPTAIN]),
    );
    expect(dto.entered_by_name).toBe("Enterer");
    expect(dto.deal_sponsor_name).toBe("Sponsor Sally");
    expect(dto.deal_captain_name).toBe("Captain Carl");
  });

  it("findByIdDTO leaves names null when the columns are null", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ entered_by: null, deal_sponsor: null, deal_captain: null }),
    );
    const findByIds = vi.fn().mockResolvedValue([]);
    const service = buildServiceWithUsers(repos, findByIds);

    const dto = await service.findByIdDTO("company-1");

    expect(findByIds).not.toHaveBeenCalled();
    expect(dto.entered_by_name).toBeNull();
    expect(dto.deal_sponsor_name).toBeNull();
    expect(dto.deal_captain_name).toBeNull();
  });

  it("listDTO resolves sponsor/captain names with a single deduplicated lookup", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.findAll).mockResolvedValue([
      makeCompany({ id: "c1", deal_sponsor: SPONSOR, deal_captain: null }),
      makeCompany({ id: "c2", deal_sponsor: SPONSOR, deal_captain: CAPTAIN }),
    ]);
    const findByIds = vi.fn().mockResolvedValue([
      { id: SPONSOR, name: "Sponsor Sally" },
      { id: CAPTAIN, name: "Captain Carl" },
    ]);
    const service = buildServiceWithUsers(repos, findByIds);

    const dtos = await service.listDTO({});

    expect(findByIds).toHaveBeenCalledTimes(1);
    const requestedIds = findByIds.mock.calls[0][0] as string[];
    expect(requestedIds.sort()).toEqual([SPONSOR, CAPTAIN].sort());
    expect(dtos[0].deal_sponsor_name).toBe("Sponsor Sally");
    expect(dtos[0].deal_captain_name).toBeNull();
    expect(dtos[1].deal_captain_name).toBe("Captain Carl");
  });
});
