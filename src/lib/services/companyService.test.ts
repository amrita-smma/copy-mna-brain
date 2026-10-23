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
import {
  CompanyDroppedError,
  CompanyPipelineRequirementsError,
  CompanyService,
  PipelineStageUnavailableError,
  RestoreStageRequiredError,
} from "./companyService";
import type { PipelineStageRepository, PipelineStageRow } from "@/lib/repositories";

vi.mock("@/lib/s3", () => ({ deleteFile: vi.fn() }));

const posthogMocks = vi.hoisted(() => ({ captureWorkspaceEvent: vi.fn() }));
vi.mock("@/lib/posthog-server", () => ({
  captureWorkspaceEvent: posthogMocks.captureWorkspaceEvent,
}));

import { deleteFile } from "@/lib/s3";

const TEST_WORKSPACE_ID = "ws-test";

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
    findByIds: vi.fn().mockResolvedValue([]),
  } as unknown as CompanyRepository;

  const companyLogRepo = {
    insert: vi.fn().mockResolvedValue(undefined),
    insertMany: vi.fn(),
    findLatestAutoSponsorLogs: vi.fn().mockResolvedValue(new Map()),
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

function makeCompanyAnalysisService() {
  return {
    regenerate: vi.fn().mockResolvedValue({ runId: 'run-1' }),
    regenerateMany: vi.fn().mockResolvedValue({ enqueued: [], skipped: [] }),
  };
}

function buildService(
  repos: ReturnType<typeof makeRepos>,
  trackMatchingService?: ReturnType<typeof makeTrackMatchingService>,
  companyAnalysisService?: Partial<ReturnType<typeof makeCompanyAnalysisService>>,
) {
  return new CompanyService(
    TEST_WORKSPACE_ID,
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
    companyAnalysisService as never,
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

  it("requires either target or project_name, like createFromDTO", async () => {
    const repos = makeRepos();
    const service = buildService(repos);

    await expect(
      service.create({ target: " ", project_name: "" } as any),
    ).rejects.toThrow("Company requires either target or project_name.");
    await expect(service.create({} as any)).rejects.toThrow(
      "Company requires either target or project_name.",
    );
    expect(repos.companyRepo.insert).not.toHaveBeenCalled();
  });

  it("allows a project-only company, so a codename-only intake can land", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.insert).mockResolvedValue(
      makeCompany({ target: null, project_name: "Project Falcon" }),
    );
    const service = buildService(repos);

    await service.create({ project_name: "Project Falcon" } as any);

    expect(repos.companyRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ project_name: "Project Falcon" }),
    );
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

describe("CompanyService.createFromDTO — Pending Confirmation arrival", () => {
  it("hands a company created into Pending Confirmation to the arrival handler", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.insert).mockResolvedValue(
      makeCompany({ id: "c-pending", pipeline_stage: "unreviewed" }),
    );
    const service = buildService(repos);
    const handler = vi.fn().mockResolvedValue(true);
    service.setPendingArrivalHandler(handler);

    await service.createFromDTO({ target: "Acme", pipeline_stage: "unreviewed" } as any);

    expect(handler).toHaveBeenCalledWith(["c-pending"], null);
  });

  it("leaves the arrival to the caller when it defers it", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.insert).mockResolvedValue(
      makeCompany({ id: "c-pending", pipeline_stage: "unreviewed" }),
    );
    const service = buildService(repos);
    const handler = vi.fn();
    service.setPendingArrivalHandler(handler);

    await service.createFromDTO({ target: "Acme" } as any, undefined, {
      deferPendingArrival: true,
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("does not call the handler for a company created outside Pending Confirmation", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.insert).mockResolvedValue(
      makeCompany({ id: "c-l0", pipeline_stage: "L0" }),
    );
    const service = buildService(repos, makeTrackMatchingService());
    const handler = vi.fn();
    service.setPendingArrivalHandler(handler);

    await service.createFromDTO({ target: "Acme" } as any);

    expect(handler).not.toHaveBeenCalled();
  });

  it("still creates the company when the arrival handler fails", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.insert).mockResolvedValue(
      makeCompany({ id: "c-pending", pipeline_stage: "unreviewed" }),
    );
    const service = buildService(repos);
    service.setPendingArrivalHandler(vi.fn().mockRejectedValue(new Error("db down")));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      service.createFromDTO({ target: "Acme" } as any),
    ).resolves.toBeDefined();
    errorSpy.mockRestore();
  });
});

describe("CompanyService — moving into Pending Confirmation", () => {
  let repos: ReturnType<typeof makeRepos>;
  let service: CompanyService;
  let handler: ReturnType<typeof vi.fn<(companyIds: string[]) => Promise<unknown>>>;

  beforeEach(() => {
    repos = makeRepos();
    service = buildService(repos);
    vi.mocked(repos.companyRepo.update).mockResolvedValue([makeCompany()]);
    handler = vi.fn<(companyIds: string[]) => Promise<unknown>>().mockResolvedValue(1);
    service.setPendingArrivalHandler(handler);
  });

  it("hands a Market Scanning company promoted to Pending Confirmation to the arrival handler", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ id: "c-1", pipeline_stage: "discovered" }),
    );

    await service.promote("c-1", "discovered", "unreviewed");

    expect(handler).toHaveBeenCalledWith(["c-1"], null);
  });

  it("credits the user who moved it in, so an auto-promote can default Entered By to them", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ id: "c-1", pipeline_stage: "discovered" }),
    );

    await service.promote("c-1", "discovered", "unreviewed", undefined, undefined, undefined, undefined, undefined, {
      triggeredByUserId: "user-7",
    });

    expect(handler).toHaveBeenCalledWith(["c-1"], "user-7");
  });

  it("does not rescan a company that is already in Pending Confirmation", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ id: "c-1", pipeline_stage: "unreviewed" }),
    );

    await service.promote("c-1", "unreviewed", "unreviewed");

    expect(handler).not.toHaveBeenCalled();
  });

  it("does not call the handler for a move to any other stage", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ id: "c-1", pipeline_stage: "L1" }),
    );

    await service.promote("c-1", "L1", "L2");

    expect(handler).not.toHaveBeenCalled();
  });

  it("still completes the promote when the arrival handler fails", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ id: "c-1", pipeline_stage: "discovered" }),
    );
    handler.mockRejectedValue(new Error("db down"));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(service.promote("c-1", "discovered", "unreviewed")).resolves.toBeUndefined();
    expect(repos.companyRepo.update).toHaveBeenCalledWith(
      "c-1",
      expect.objectContaining({ pipeline_stage: "unreviewed" }),
    );
    errorSpy.mockRestore();
  });

  it("hands every bulk-moved company to the arrival handler in one call", async () => {
    vi.mocked(repos.companyRepo.findByIds).mockResolvedValue([
      makeCompany({ id: "c-1", pipeline_stage: "discovered" }),
      makeCompany({ id: "c-2", pipeline_stage: "discovered" }),
      makeCompany({ id: "c-3", pipeline_stage: "unreviewed" }),
    ]);

    await service.promoteMany(
      [
        { id: "c-1", currentStage: "discovered" },
        { id: "c-2", currentStage: "discovered" },
        { id: "c-3", currentStage: "unreviewed" },
      ],
      "unreviewed",
      "user-7",
    );

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(["c-1", "c-2"], "user-7");
  });

  it("does not rescan bulk moves when the stored stage is already Pending Confirmation", async () => {
    vi.mocked(repos.companyRepo.findByIds).mockResolvedValue([
      makeCompany({ id: "c-1", pipeline_stage: "unreviewed" }),
    ]);

    await service.promoteMany([{ id: "c-1", currentStage: "discovered" }], "unreviewed");

    expect(handler).not.toHaveBeenCalled();
  });

  it("hands a company moved via the Current Stage dropdown to the arrival handler", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ id: "c-1", pipeline_stage: "discovered" }),
    );

    await service.updateFromDTO("c-1", { pipeline_stage: "unreviewed" } as never, undefined, {
      triggeredByUserId: "user-7",
    });

    expect(handler).toHaveBeenCalledWith(["c-1"], "user-7");
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
      TEST_WORKSPACE_ID,
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

describe("CompanyService.promote — demoting out of L0", () => {
  let repos: ReturnType<typeof makeRepos>;
  let service: CompanyService;
  const trackSvc = { dispatch: vi.fn(), runSync: vi.fn().mockResolvedValue({ matchedTrackIds: [] }) };

  beforeEach(() => {
    repos = makeRepos();
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ pipeline_stage: "L0", target: "Acme Corp" }),
    );
    service = buildService(repos, trackSvc as never);
    vi.mocked(repos.companyRepo.update).mockResolvedValue([makeCompany()]);
  });

  it("moves the company back to the unreviewed (Pending Confirmation) bucket", async () => {
    await service.promote("company-1", "L0", "unreviewed");
    expect(repos.companyRepo.update).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ pipeline_stage: "unreviewed" }),
    );
  });

  it("does not apply the pipeline requirements gate when leaving L0", async () => {
    // The gate only fires on *entry* to L0 — a company missing required fields
    // must still be able to fall back out of the pipeline.
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ pipeline_stage: "L0", entered_by: null, geography: null, banker: null }),
    );
    await expect(service.promote("company-1", "L0", "unreviewed")).resolves.toBeUndefined();
  });

  it("does not run track matching on the way out of L0", async () => {
    await service.promote("company-1", "L0", "unreviewed");
    expect(trackSvc.runSync).not.toHaveBeenCalled();
  });

  it("logs the move and records the optional reason as a stage note", async () => {
    await service.promote("company-1", "L0", "unreviewed", "Needs re-triage");
    expect(repos.companyLogRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ action: "PROMOTED_FROM_L0_TO_unreviewed" }),
    );
    expect(repos.dealNoteRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Needs re-triage", stage: "L0" }),
    );
  });

  it("captures the move as deal_demoted", async () => {
    await service.promote("company-1", "L0", "unreviewed");
    expect(posthogMocks.captureWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "deal_demoted",
        properties: expect.objectContaining({ from_stage: "L0", to_stage: "unreviewed" }),
      }),
    );
  });

  it("still regenerates the Company Card, like any other stage move", async () => {
    const analysis = makeCompanyAnalysisService();
    const demoteService = buildService(repos, trackSvc as never, analysis);

    await demoteService.promote("company-1", "L0", "unreviewed");

    expect(analysis.regenerate).toHaveBeenCalledWith("company-1", {
      reason: "stage move L0 -> unreviewed",
      source: "stage_move",
    });
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

  // Figures not submitted are carried over, and so is a ratio whose own inputs
  // didn't move — but the margin must be recomputed, since keeping the stored
  // one would publish a percentage computed against the previous revenue on the
  // company card and the Excel export.
  it("preserves untouched figures and recomputes only the affected ratio", async () => {
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
          // 20 / 150, not the stored 0.2 computed against the old revenue.
          ebitda_margin: 20 / 150,
          // EV and EBITDA didn't move, so the stored multiple stands.
          ev_ebitda: "25",
          // Cross-year value owned by the screening pipeline — left alone.
          revenue_cagr_vs_prior: "0.1",
        }),
      ]),
    );
  });

  it("clears margin and multiple when their inputs are cleared", async () => {
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
        revenue_cagr_vs_prior: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);

    await service.updateFinancials(
      "company-1",
      [{ fiscal_year: 2024, ebitda_usd_mn: null }],
      [],
    );

    expect(
      repos.companyFinancialRepo.bulkUpsertForCompany,
    ).toHaveBeenCalledWith(
      "company-1",
      expect.arrayContaining([
        expect.objectContaining({
          fiscal_year: 2024,
          ebitda_usd_mn: null,
          ebitda_margin: null,
          ev_ebitda: null,
        }),
      ]),
    );
  });

  // The FE charts PUT a single metric. A revenue-only save must not be read as
  // a reason to recompute EV/EBITDA — that would wipe a multiple ingest or
  // screening stored for a year with no EV on file.
  it("leaves the multiple alone on a revenue-only save", async () => {
    vi.mocked(repos.companyFinancialRepo.findByCompany).mockResolvedValue([
      {
        id: "fin-1",
        company_id: "company-1",
        fiscal_year: 2024,
        revenue_usd_mn: "100" as any,
        ebitda_usd_mn: "20" as any,
        ev_usd_mn: null,
        ebitda_margin: "0.2" as any,
        ev_ebitda: "11.5" as any,
        revenue_cagr_vs_prior: null,
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
          ebitda_margin: 20 / 150,
          ev_ebitda: "11.5",
        }),
      ]),
    );
  });

  it("leaves the margin alone on an EV-only save", async () => {
    vi.mocked(repos.companyFinancialRepo.findByCompany).mockResolvedValue([
      {
        id: "fin-1",
        company_id: "company-1",
        fiscal_year: 2024,
        revenue_usd_mn: null,
        ebitda_usd_mn: "20" as any,
        ev_usd_mn: "500" as any,
        ebitda_margin: "0.18" as any,
        ev_ebitda: "25" as any,
        revenue_cagr_vs_prior: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);

    await service.updateFinancials(
      "company-1",
      [{ fiscal_year: 2024, ev_usd_mn: 640 }],
      [],
    );

    expect(
      repos.companyFinancialRepo.bulkUpsertForCompany,
    ).toHaveBeenCalledWith(
      "company-1",
      expect.arrayContaining([
        expect.objectContaining({
          fiscal_year: 2024,
          ebitda_margin: "0.18",
          ev_ebitda: 32,
        }),
      ]),
    );
  });

  // A zero denominator must not become Infinity in a numeric column.
  it("leaves margin null rather than dividing by zero revenue", async () => {
    vi.mocked(repos.companyFinancialRepo.findByCompany).mockResolvedValue([]);

    await service.updateFinancials(
      "company-1",
      [{ fiscal_year: 2024, revenue_usd_mn: 0, ebitda_usd_mn: 5 }],
      [],
    );

    expect(
      repos.companyFinancialRepo.bulkUpsertForCompany,
    ).toHaveBeenCalledWith(
      "company-1",
      expect.arrayContaining([
        expect.objectContaining({ fiscal_year: 2024, ebitda_margin: null }),
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

  // The AI Workforce's update_company_details tool sets EV per year; the FE
  // financials editor never sends it, so an omitted key must keep the stored
  // value rather than blanking it.
  it("writes a submitted ev_usd_mn over the stored one", async () => {
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
      [{ fiscal_year: 2024, ev_usd_mn: 640 }],
      [],
    );

    expect(
      repos.companyFinancialRepo.bulkUpsertForCompany,
    ).toHaveBeenCalledWith(
      "company-1",
      expect.arrayContaining([
        expect.objectContaining({
          fiscal_year: 2024,
          ev_usd_mn: 640,
          revenue_usd_mn: "100",
          ebitda_usd_mn: "20",
        }),
      ]),
    );
  });

  it("clears ev_usd_mn when null is submitted explicitly", async () => {
    vi.mocked(repos.companyFinancialRepo.findByCompany).mockResolvedValue([
      {
        id: "fin-1",
        company_id: "company-1",
        fiscal_year: 2024,
        revenue_usd_mn: "100" as any,
        ebitda_usd_mn: "20" as any,
        ev_usd_mn: "500" as any,
        ebitda_margin: null,
        ev_ebitda: null,
        revenue_cagr_vs_prior: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ]);

    await service.updateFinancials(
      "company-1",
      [{ fiscal_year: 2024, ev_usd_mn: null }],
      [],
    );

    expect(
      repos.companyFinancialRepo.bulkUpsertForCompany,
    ).toHaveBeenCalledWith(
      "company-1",
      expect.arrayContaining([
        expect.objectContaining({ fiscal_year: 2024, ev_usd_mn: null }),
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

describe("CompanyService.promote — pipeline requirements guard", () => {
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

  it("throws CompanyPipelineRequirementsError listing all missing fields", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ pipeline_stage: "market_screening", entered_by: null, geography: null, banker: null }),
    );
    await expect(service.promote("company-1", "market_screening", "L0")).rejects.toThrow(CompanyPipelineRequirementsError);
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

  it("defaults a blank entered_by to the promoting user and passes the gate", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ ...l0BaseCompany, entered_by: null }),
    );
    await expect(
      service.promote("company-1", "market_screening", "L0", undefined, undefined, undefined, undefined, undefined, {
        triggeredByUserId: "user-42",
      }),
    ).resolves.toBeUndefined();
    expect(repos.companyRepo.update).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ pipeline_stage: "L0", entered_by: "user-42" }),
    );
  });

  it("keeps an existing entered_by rather than overwriting it with the promoting user", async () => {
    await service.promote("company-1", "market_screening", "L0", undefined, undefined, undefined, undefined, undefined, {
      triggeredByUserId: "user-42",
    });
    expect(repos.companyRepo.update).toHaveBeenCalledWith(
      "company-1",
      expect.not.objectContaining({ entered_by: expect.anything() }),
    );
  });

  it("still blocks a blank entered_by when there is no promoting user", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ ...l0BaseCompany, entered_by: null }),
    );
    await expect(service.promote("company-1", "market_screening", "L0")).rejects.toMatchObject({
      missingFields: ["Entered By"],
    });
  });

  it("does not stamp entered_by on a move that is not an L0 entry", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ ...l0BaseCompany, pipeline_stage: "market_screening", entered_by: null }),
    );
    await service.promote("company-1", "market_screening", "unreviewed", undefined, undefined, undefined, undefined, undefined, {
      triggeredByUserId: "user-42",
    });
    expect(repos.companyRepo.update).toHaveBeenCalledWith(
      "company-1",
      expect.not.objectContaining({ entered_by: expect.anything() }),
    );
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
    await expect(service.promote("company-1", "unreviewed", "L0")).rejects.toBeInstanceOf(CompanyPipelineRequirementsError);
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

describe("CompanyService — workspace Required Fields configuration", () => {
  let repos: ReturnType<typeof makeRepos>;
  let service: CompanyService;
  let workspaceFindById: ReturnType<typeof vi.fn>;
  const trackSvc = { dispatch: vi.fn(), runSync: vi.fn().mockResolvedValue({ matchedTrackIds: [] }) };

  beforeEach(() => {
    repos = makeRepos();
    service = buildService(repos, trackSvc as never);
    workspaceFindById = vi.fn();
    service.setWorkspaceRepo({ findById: workspaceFindById } as never);
  });

  it("promotes to L0 when the only missing fields are ones the workspace switched off", async () => {
    workspaceFindById.mockResolvedValue({ pipeline_required_fields: ["name", "source"] });
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ ...l0BaseCompany, entered_by: null, geography: null, banker: null }),
    );
    await expect(service.promote("company-1", "market_screening", "L0")).resolves.toBeUndefined();
    expect(workspaceFindById).toHaveBeenCalledWith(TEST_WORKSPACE_ID);
  });

  it("still blocks on a field the workspace keeps required", async () => {
    workspaceFindById.mockResolvedValue({ pipeline_required_fields: ["name", "geography"] });
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ ...l0BaseCompany, entered_by: null, geography: null, banker: null }),
    );
    await expect(service.promote("company-1", "market_screening", "L0")).rejects.toMatchObject({
      missingFields: ["Geo"],
    });
  });

  it("enforces every field when the workspace never configured it (NULL)", async () => {
    workspaceFindById.mockResolvedValue({ pipeline_required_fields: null });
    await expect(
      service.missingPipelineFields({ target: "Acme", source: "inbound" }),
    ).resolves.toEqual(["Entered By", "Deal Type", "Geo", "Sector", "Banker"]);
  });

  it("applies the configuration on the Current Stage dropdown path too", async () => {
    workspaceFindById.mockResolvedValue({ pipeline_required_fields: ["name"] });
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ ...l0BaseCompany, pipeline_stage: "unreviewed", entered_by: null, geography: null }),
    );
    await expect(service.updateFromDTO("company-1", { pipeline_stage: "L0" } as never)).resolves.toBeDefined();
  });

  it("reads the workspace once per service instance", async () => {
    workspaceFindById.mockResolvedValue({ pipeline_required_fields: ["name"] });
    await service.missingPipelineFields({ target: "A" });
    await service.missingPipelineFields({ target: "B" });
    expect(workspaceFindById).toHaveBeenCalledTimes(1);
  });
});

describe("CompanyService.updateFromDTO — pipeline requirements guard on stage change", () => {
  let repos: ReturnType<typeof makeRepos>;
  let service: CompanyService;

  beforeEach(() => {
    repos = makeRepos();
    service = buildService(repos);
  });

  it("throws CompanyPipelineRequirementsError moving pre-L0 → L0 with missing fields", async () => {
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
      CompanyPipelineRequirementsError,
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
      CompanyPipelineRequirementsError,
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

describe("CompanyService.checkPipelineRequirements", () => {
  it("returns empty array when all fields present (inbound)", () => {
    expect(CompanyService.checkPipelineRequirements({
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
    expect(CompanyService.checkPipelineRequirements({
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
    const missing = CompanyService.checkPipelineRequirements({
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
    const missing = CompanyService.checkPipelineRequirements({});
    expect(missing).toEqual(expect.arrayContaining([
      "Company Name / Project Name",
      "Entered By",
      "Deal Type: Inbound/Outbound",
      "Deal Type",
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
      TEST_WORKSPACE_ID,
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

  it("findByIdDTO carries the auto-assignment reason while the sponsor is still the auto pick", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(makeCompany({ deal_sponsor: SPONSOR }));
    vi.mocked(repos.companyLogRepo.findLatestAutoSponsorLogs).mockResolvedValue(
      new Map([
        [
          "company-1",
          { company_id: "company-1", user_id: SPONSOR, reason: "covers Firm X", created_at: "2026-10-21" },
        ],
      ]),
    );
    const service = buildServiceWithUsers(repos, vi.fn().mockResolvedValue([]));

    const dto = await service.findByIdDTO("company-1");

    expect(repos.companyLogRepo.findLatestAutoSponsorLogs).toHaveBeenCalledWith(["company-1"]);
    expect(dto.deal_sponsor_auto_reason).toBe("covers Firm X");
  });

  it("findByIdDTO drops the auto-assignment reason once someone changed the sponsor", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(makeCompany({ deal_sponsor: CAPTAIN }));
    vi.mocked(repos.companyLogRepo.findLatestAutoSponsorLogs).mockResolvedValue(
      new Map([
        [
          "company-1",
          { company_id: "company-1", user_id: SPONSOR, reason: "covers Firm X", created_at: "2026-10-21" },
        ],
      ]),
    );
    const service = buildServiceWithUsers(repos, vi.fn().mockResolvedValue([]));

    expect((await service.findByIdDTO("company-1")).deal_sponsor_auto_reason).toBeNull();
  });

  it("findByIdDTO does not look up auto-assignments for a company with no sponsor", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(makeCompany({ deal_sponsor: null }));
    const service = buildServiceWithUsers(repos, vi.fn().mockResolvedValue([]));

    expect((await service.findByIdDTO("company-1")).deal_sponsor_auto_reason).toBeNull();
    expect(repos.companyLogRepo.findLatestAutoSponsorLogs).not.toHaveBeenCalled();
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

  it("listDTO reads auto-assignments in one query, only for companies with a sponsor", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.findAll).mockResolvedValue([
      makeCompany({ id: "c1", deal_sponsor: SPONSOR }),
      makeCompany({ id: "c2", deal_sponsor: null }),
    ]);
    vi.mocked(repos.companyLogRepo.findLatestAutoSponsorLogs).mockResolvedValue(
      new Map([["c1", { company_id: "c1", user_id: SPONSOR, reason: null, created_at: null }]]),
    );
    const service = buildServiceWithUsers(repos, vi.fn().mockResolvedValue([]));

    const dtos = await service.listDTO({});

    expect(repos.companyLogRepo.findLatestAutoSponsorLogs).toHaveBeenCalledTimes(1);
    expect(repos.companyLogRepo.findLatestAutoSponsorLogs).toHaveBeenCalledWith(["c1"]);
    expect(dtos.map((d) => d.deal_sponsor_auto_reason)).toEqual(["Auto-assigned", null]);
  });
});

describe('CompanyService — Company Card regeneration on a stage move', () => {
  it('regenerates the card after a promote, naming the stages as the reason', async () => {
    const repos = makeRepos();
    const analysis = makeCompanyAnalysisService();
    const service = buildService(repos, undefined, analysis);

    await service.promote('company-1', 'L1', 'L2');

    expect(analysis.regenerate).toHaveBeenCalledWith('company-1', {
      reason: 'stage move L1 -> L2',
      source: 'stage_move',
    });
  });

  it('regenerates after the stage write has landed, not before', async () => {
    const repos = makeRepos();
    const order: string[] = [];
    vi.mocked(repos.companyRepo.update).mockImplementation(async () => {
      order.push('update');
      return [] as never;
    });
    const analysis = {
      regenerate: vi.fn().mockImplementation(async () => {
        order.push('regenerate');
        return { runId: 'run-1' };
      }),
    };
    const service = buildService(repos, undefined, analysis);

    await service.promote('company-1', 'L1', 'L2');

    expect(order).toEqual(['update', 'regenerate']);
  });

  it('omits the previous stage from the reason when it is unknown', async () => {
    const repos = makeRepos();
    const analysis = makeCompanyAnalysisService();
    const service = buildService(repos, undefined, analysis);

    await service.promote('company-1', undefined, 'L1');

    expect(analysis.regenerate).toHaveBeenCalledWith('company-1', {
      reason: 'stage move to L1',
      source: 'stage_move',
    });
  });

  it('does not fail the promote when the regeneration enqueue throws', async () => {
    const repos = makeRepos();
    const analysis = {
      regenerate: vi.fn().mockRejectedValue(new Error('workforce unavailable')),
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = buildService(repos, undefined, analysis);

    await expect(service.promote('company-1', 'L1', 'L2')).resolves.toBeUndefined();

    // The stage move itself is already committed, so a card failure is logged, not thrown.
    expect(repos.companyRepo.update).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('is a no-op when no analysis service is wired in', async () => {
    const repos = makeRepos();
    const service = buildService(repos);

    await expect(service.promote('company-1', 'L1', 'L2')).resolves.toBeUndefined();
  });

  it('routes a bulk promote through the batched path, not one regenerate per deal', async () => {
    const repos = makeRepos();
    const analysis = makeCompanyAnalysisService();
    const service = buildService(repos, undefined, analysis);

    await service.promoteMany(
      [
        { id: 'c-1', currentStage: 'L1' },
        { id: 'c-2', currentStage: 'L2' },
      ],
      'L3',
    );

    // Per-deal regenerate() would fire two reads per deal; regenerateMany
    // batches the in-flight check and the name lookup.
    expect(analysis.regenerate).not.toHaveBeenCalled();
    expect(analysis.regenerateMany).toHaveBeenCalledOnce();
    const [ids, opts] = analysis.regenerateMany.mock.calls[0];
    expect(ids).toEqual(['c-1', 'c-2']);
    expect(opts.source).toBe('stage_move');
    expect(opts.reasonById.get('c-1')).toBe('stage move L1 -> L3');
    expect(opts.reasonById.get('c-2')).toBe('stage move L2 -> L3');
  });

  it('does not fail a bulk promote when the batched regeneration throws', async () => {
    const repos = makeRepos();
    const analysis = {
      regenerate: vi.fn(),
      regenerateMany: vi.fn().mockRejectedValue(new Error('workforce unavailable')),
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const service = buildService(repos, undefined, analysis);

    await expect(
      service.promoteMany([{ id: 'c-1', currentStage: 'L1' }], 'L2'),
    ).resolves.toBeUndefined();

    expect(repos.companyRepo.updateMany).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('skips the batched regeneration entirely for an empty bulk promote', async () => {
    const repos = makeRepos();
    const analysis = makeCompanyAnalysisService();
    const service = buildService(repos, undefined, analysis);

    await service.promoteMany([], 'L3');

    expect(analysis.regenerateMany).not.toHaveBeenCalled();
  });

  it('regenerates when the Current Stage dropdown moves the company', async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ pipeline_stage: 'L2' }),
    );
    vi.mocked(repos.companyRepo.findDetails).mockResolvedValue({
      company: makeCompany({ pipeline_stage: 'L3' }),
      financials: [],
      fx: [],
      screening: null,
    } as never);
    const analysis = makeCompanyAnalysisService();
    const service = buildService(repos, undefined, analysis);

    await service.updateFromDTO('company-1', { pipeline_stage: 'L3' } as never);

    expect(analysis.regenerate).toHaveBeenCalledWith('company-1', {
      reason: 'stage move L2 -> L3',
      source: 'stage_move',
    });
  });

  it('does NOT regenerate when a detail-only save echoes the current stage', async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ pipeline_stage: 'L2' }),
    );
    vi.mocked(repos.companyRepo.findDetails).mockResolvedValue({
      company: makeCompany({ pipeline_stage: 'L2' }),
      financials: [],
      fx: [],
      screening: null,
    } as never);
    const analysis = makeCompanyAnalysisService();
    const service = buildService(repos, undefined, analysis);

    await service.updateFromDTO('company-1', {
      pipeline_stage: 'L2',
      comments: 'just a note',
    } as never);

    expect(analysis.regenerate).not.toHaveBeenCalled();
  });

  it('does NOT regenerate on an update that carries no stage at all', async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.findDetails).mockResolvedValue({
      company: makeCompany({ pipeline_stage: 'L2' }),
      financials: [],
      fx: [],
      screening: null,
    } as never);
    const analysis = makeCompanyAnalysisService();
    const service = buildService(repos, undefined, analysis);

    await service.updateFromDTO('company-1', { comments: 'just a note' } as never);

    expect(analysis.regenerate).not.toHaveBeenCalled();
  });
});

describe("CompanyService.promote — telemetry", () => {
  it("captures deal_promoted server-side, attributed to the acting user", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ pipeline_stage: "L1", target: "Acme Corp" }),
    );
    const service = buildService(repos);

    await service.promote("company-1", "L1", "L2", undefined, undefined, undefined, undefined, undefined, {
      triggeredByUserId: "user-7",
    });

    expect(posthogMocks.captureWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: TEST_WORKSPACE_ID,
        distinctId: "user-7",
        event: "deal_promoted",
      }),
    );
  });

  it("captures deal_demoted when the move goes backwards", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ pipeline_stage: "L2" }),
    );
    const service = buildService(repos);

    await service.promote("company-1", "L2", "L1");

    expect(posthogMocks.captureWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "deal_demoted" }),
    );
  });

  it("falls back to 'server' for callers with no session (agent tools, bulk triage)", async () => {
    const repos = makeRepos();
    const service = buildService(repos);

    await service.promote("company-1", "L1", "L2");

    expect(posthogMocks.captureWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ distinctId: "server" }),
    );
  });

  it("carries the stage move and note/link flags as properties", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ pipeline_stage: "L1", target: "Acme Corp" }),
    );
    const service = buildService(repos);

    await service.promote(
      "company-1",
      "L1",
      "L2",
      "a note",
      "https://x.test",
      "X",
      undefined,
      undefined,
      { hasDocument: true },
    );

    expect(posthogMocks.captureWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          deal_id: "company-1",
          company_name: "Acme Corp",
          from_stage: "L1",
          to_stage: "L2",
          has_note: true,
          has_link: true,
          has_reason: false,
          has_document: true,
        }),
      }),
    );
  });

  it("does not capture when the promotion throws before completing", async () => {
    const repos = makeRepos();
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ status: "dropped" } as Partial<Company>),
    );
    const service = buildService(repos);

    await expect(service.promote("company-1", "L1", "L2")).rejects.toThrow(
      CompanyDroppedError,
    );
    expect(posthogMocks.captureWorkspaceEvent).not.toHaveBeenCalled();
  });
});

describe("CompanyService.promoteMany — telemetry", () => {
  it("captures one event per deal so bulk moves are not invisible", async () => {
    const repos = makeRepos();
    const service = buildService(repos);

    await service.promoteMany(
      [
        { id: "company-1", currentStage: "L1" },
        { id: "company-2", currentStage: "L1" },
      ],
      "L2",
      "user-7",
    );

    const moves = posthogMocks.captureWorkspaceEvent.mock.calls.filter(
      ([arg]) => arg.event === "deal_promoted",
    );
    expect(moves).toHaveLength(2);
    expect(moves.map(([arg]) => arg.properties.deal_id)).toEqual([
      "company-1",
      "company-2",
    ]);
  });

  it("attributes bulk moves to the acting user and marks them as bulk", async () => {
    const repos = makeRepos();
    const service = buildService(repos);

    await service.promoteMany([{ id: "company-1", currentStage: "L1" }], "L2", "user-7");

    expect(posthogMocks.captureWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: TEST_WORKSPACE_ID,
        distinctId: "user-7",
        event: "deal_promoted",
        properties: expect.objectContaining({ bulk: true, bulk_size: 1 }),
      }),
    );
  });

  it("captures deal_demoted for a backwards bulk move", async () => {
    const repos = makeRepos();
    const service = buildService(repos);

    await service.promoteMany([{ id: "company-1", currentStage: "L3" }], "L1");

    expect(posthogMocks.captureWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "deal_demoted", distinctId: "server" }),
    );
  });

  it("captures nothing for an empty deal list", async () => {
    const repos = makeRepos();
    const service = buildService(repos);

    await service.promoteMany([], "L2");

    expect(posthogMocks.captureWorkspaceEvent).not.toHaveBeenCalled();
  });
});

describe("CompanyService.countByStage", () => {
  function buildWithRows(
    rows: Array<{
      stage: string | null;
      source: string | null;
      watchlist_status: string | null;
      count: number;
    }>,
  ) {
    const repos = makeRepos();
    (repos.companyRepo as unknown as {
      countByStageAndSource: ReturnType<typeof vi.fn>;
    }).countByStageAndSource = vi.fn().mockResolvedValue(rows);
    return { service: buildService(repos), repos };
  }

  it("sums each stage from a single grouped query", async () => {
    const { service, repos } = buildWithRows([
      { stage: "L0", source: "inbound", watchlist_status: null, count: 5 },
      { stage: "L0", source: "outbound", watchlist_status: null, count: 3 },
      { stage: "L2", source: "outbound", watchlist_status: null, count: 4 },
    ]);

    const result = await service.countByStage({ excludeDropped: true });

    expect(
      (repos.companyRepo as unknown as { countByStageAndSource: ReturnType<typeof vi.fn> })
        .countByStageAndSource,
    ).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      { stage: "L0", count: 8, inbound: 5, outbound: 3 },
      { stage: "L2", count: 4, inbound: 0, outbound: 4 },
    ]);
  });

  it("falls back to watchlist_status when source is unset", async () => {
    const { service } = buildWithRows([
      { stage: "L1", source: null, watchlist_status: "active", count: 2 },
      { stage: "L1", source: null, watchlist_status: "Inbound lead", count: 1 },
      { stage: "L1", source: null, watchlist_status: "cold outreach", count: 6 },
      { stage: "L1", source: null, watchlist_status: null, count: 4 },
    ]);

    await expect(service.countByStage()).resolves.toEqual([
      { stage: "L1", count: 13, inbound: 3, outbound: 10 },
    ]);
  });

  it("buckets a company with no stage under L0, matching the dashboard", async () => {
    const { service } = buildWithRows([
      { stage: null, source: "inbound", watchlist_status: null, count: 2 },
      { stage: "L0", source: "inbound", watchlist_status: null, count: 1 },
    ]);

    await expect(service.countByStage()).resolves.toEqual([
      { stage: "L0", count: 3, inbound: 3, outbound: 0 },
    ]);
  });

  it("returns [] when the workspace has no companies", async () => {
    const { service } = buildWithRows([]);
    await expect(service.countByStage()).resolves.toEqual([]);
  });
});

function stageRow(key: string, position: number, deleted = false): PipelineStageRow {
  return {
    id: `id-${key}`,
    workspace_id: TEST_WORKSPACE_ID,
    key,
    code: key,
    name: key,
    description: "",
    position,
    created_at: "2026-10-04T00:00:00Z",
    updated_at: "2026-10-04T00:00:00Z",
    deleted_at: deleted ? "2026-10-04T00:00:00Z" : null,
  };
}

/**
 * L0, L1, L2, a custom stage between L2 and L3, L3 (deleted when asked),
 * L4, L5 and a custom stage after L5.
 */
function makeStageRepo(opts: { l3Deleted?: boolean } = {}) {
  const rows = [
    stageRow("L0", 0),
    stageRow("L1", 1),
    stageRow("L2", 2),
    stageRow("stg-mid", 3),
    stageRow("L3", 4, opts.l3Deleted),
    stageRow("L4", 5),
    stageRow("L5", 6),
    stageRow("stg-late", 7),
  ];
  return { list: vi.fn().mockResolvedValue(rows) } as unknown as PipelineStageRepository;
}

function buildServiceWithStages(
  repos: ReturnType<typeof makeRepos>,
  stageRepo: PipelineStageRepository,
  trackMatchingService?: ReturnType<typeof makeTrackMatchingService>,
) {
  return new CompanyService(
    TEST_WORKSPACE_ID,
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
    undefined,
    stageRepo,
  );
}

const SPONSOR = "5f0e3f9a-1111-4222-8333-444455556666";

describe("CompanyService — workspace pipeline stages", () => {
  let repos: ReturnType<typeof makeRepos>;

  beforeEach(() => {
    repos = makeRepos();
    vi.mocked(repos.companyRepo.update).mockResolvedValue([makeCompany()]);
  });

  it("refuses to promote into a deleted stage", async () => {
    const service = buildServiceWithStages(repos, makeStageRepo({ l3Deleted: true }));
    await expect(service.promote("company-1", "L2", "L3")).rejects.toBeInstanceOf(
      PipelineStageUnavailableError,
    );
    expect(repos.companyRepo.update).not.toHaveBeenCalled();
  });

  it("refuses to promote into a stage the workspace never had", async () => {
    const service = buildServiceWithStages(repos, makeStageRepo());
    await expect(service.promote("company-1", "L2", "stg-unknown")).rejects.toBeInstanceOf(
      PipelineStageUnavailableError,
    );
  });

  it("allows demoting into the pre-pipeline Pending Confirmation bucket", async () => {
    const service = buildServiceWithStages(repos, makeStageRepo());
    await service.promote("company-1", "L0", "unreviewed");
    expect(repos.companyRepo.update).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ pipeline_stage: "unreviewed" }),
    );
  });

  it("promotes into a custom stage and logs the move with its key", async () => {
    const service = buildServiceWithStages(repos, makeStageRepo());
    await service.promote("company-1", "L2", "stg-mid");
    expect(repos.companyLogRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ action: "PROMOTED_FROM_L2_TO_stg-mid" }),
    );
  });

  it("sets Deal Captain on entry to a custom stage ordered after L3", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ deal_sponsor: SPONSOR, deal_captain: null }),
    );
    const service = buildServiceWithStages(repos, makeStageRepo());
    await service.promote("company-1", "L5", "stg-late");
    expect(repos.companyRepo.update).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ deal_captain: SPONSOR }),
    );
  });

  it("does not set Deal Captain on entry to a custom stage ordered before L3", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ deal_sponsor: SPONSOR, deal_captain: null }),
    );
    const service = buildServiceWithStages(repos, makeStageRepo());
    await service.promote("company-1", "L2", "stg-mid");
    expect(vi.mocked(repos.companyRepo.update).mock.calls[0][1]).not.toHaveProperty("deal_captain");
  });

  it("keeps the Deal Captain range anchored where L3 sat after L3 is deleted", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(
      makeCompany({ deal_sponsor: SPONSOR, deal_captain: null }),
    );
    const service = buildServiceWithStages(repos, makeStageRepo({ l3Deleted: true }));
    await service.promote("company-1", "L2", "L4");
    expect(repos.companyRepo.update).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ deal_captain: SPONSOR }),
    );
  });

  it("treats a demotion from a custom stage into L0 as a demotion, not an L0 entry", async () => {
    const trackMatching = makeTrackMatchingService();
    // Missing every required field: an entry would be blocked by the requirements guard.
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(makeCompany({ target: null }));
    const service = buildServiceWithStages(repos, makeStageRepo(), trackMatching);
    await service.promote("company-1", "stg-mid", "L0");
    expect(repos.companyRepo.update).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ pipeline_stage: "L0" }),
    );
    expect(trackMatching.dispatch).not.toHaveBeenCalled();
  });

  it("reads the stage list once across several moves on one service", async () => {
    const stageRepo = makeStageRepo();
    const service = buildServiceWithStages(repos, stageRepo);
    await service.promote("company-1", "L1", "L2");
    await service.promote("company-1", "L2", "stg-mid");
    expect(stageRepo.list).toHaveBeenCalledTimes(1);
  });

  it("refuses a bulk move into a deleted stage before writing anything", async () => {
    const service = buildServiceWithStages(repos, makeStageRepo({ l3Deleted: true }));
    await expect(
      service.promoteMany([{ id: "company-1", currentStage: "L2" }], "L3"),
    ).rejects.toBeInstanceOf(PipelineStageUnavailableError);
    expect(repos.companyRepo.updateMany).not.toHaveBeenCalled();
  });

  it("refuses a Current Stage edit into a deleted stage", async () => {
    vi.mocked(repos.companyRepo.findById).mockResolvedValue(makeCompany({ pipeline_stage: "L2" }));
    const service = buildServiceWithStages(repos, makeStageRepo({ l3Deleted: true }));
    await expect(
      service.updateFromDTO("company-1", { pipeline_stage: "L3" } as never),
    ).rejects.toBeInstanceOf(PipelineStageUnavailableError);
    expect(repos.companyRepo.update).not.toHaveBeenCalled();
  });

  it("asks for a stage when restoring a deal whose stage was deleted", async () => {
    const service = buildServiceWithStages(repos, makeStageRepo({ l3Deleted: true }));
    await expect(service.restoreDeal("company-1", "L3")).rejects.toBeInstanceOf(
      RestoreStageRequiredError,
    );
    expect(repos.companyRepo.update).not.toHaveBeenCalled();
  });

  it("restores a deal whose stage was deleted into the chosen stage", async () => {
    const service = buildServiceWithStages(repos, makeStageRepo({ l3Deleted: true }));
    await service.restoreDeal("company-1", "L3", "L4");
    expect(repos.companyRepo.update).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ status: "active", pipeline_stage: "L4" }),
    );
    expect(repos.companyLogRepo.insert).toHaveBeenCalledWith({
      company_id: "company-1",
      action: "RESTORED_TO_L4",
    });
  });

  it("refuses to restore into a deleted stage", async () => {
    const service = buildServiceWithStages(repos, makeStageRepo({ l3Deleted: true }));
    await expect(service.restoreDeal("company-1", "L2", "L3")).rejects.toBeInstanceOf(
      PipelineStageUnavailableError,
    );
  });

  it("restores a deal at a live stage without moving it", async () => {
    const service = buildServiceWithStages(repos, makeStageRepo());
    await service.restoreDeal("company-1", "stg-mid");
    expect(vi.mocked(repos.companyRepo.update).mock.calls[0][1]).not.toHaveProperty("pipeline_stage");
  });

  it("refuses to create a company at a deleted stage", async () => {
    const service = buildServiceWithStages(repos, makeStageRepo({ l3Deleted: true }));
    await expect(
      service.createFromDTO({ target: "Acme", pipeline_stage: "L3" } as never),
    ).rejects.toBeInstanceOf(PipelineStageUnavailableError);
    expect(repos.companyRepo.insert).not.toHaveBeenCalled();
  });

  it("refuses a bulk update into an unknown stage but allows one that leaves the stage alone", async () => {
    const service = buildServiceWithStages(repos, makeStageRepo());
    await expect(
      service.updateMany(["company-1"], { pipeline_stage: "L9" } as never),
    ).rejects.toBeInstanceOf(PipelineStageUnavailableError);
    expect(repos.companyRepo.updateMany).not.toHaveBeenCalled();

    vi.mocked(repos.companyRepo.updateMany).mockResolvedValue([]);
    await service.updateMany(["company-1"], { remarks: "note" } as never);
    expect(repos.companyRepo.updateMany).toHaveBeenCalled();
  });
});
