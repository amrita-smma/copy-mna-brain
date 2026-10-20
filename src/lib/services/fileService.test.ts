import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileRepository,
  type CriteriaRepository,
  type ScreeningRepository,
  type CompanyFinancialRepository,
  type CompanyFxAdjustmentRepository,
  type DbClient,
  type Tables,
  type UserWorkspaceRepository,
} from '@/lib/repositories';
import type { CompanyAnalysisService } from './companyAnalysisService';
import type { AIScreeningService } from './aiScreeningService';
import type { CompanyService } from './companyService';
import { getMissingPipelineFields, type PipelineEntryCompanyInput } from '@/lib/pipeline/requiredFields';
import {
  FileService,
  FileCompanyNameRequiredError,
  type ApproveFileInput,
} from './fileService';

vi.mock('@/lib/s3', () => ({
  downloadFile: vi.fn(),
  getSignedUrl: vi.fn(),
  deleteFile: vi.fn(),
}));

const posthogMocks = vi.hoisted(() => ({ captureWorkspaceEvent: vi.fn() }));
vi.mock('@/lib/posthog-server', () => ({
  captureWorkspaceEvent: posthogMocks.captureWorkspaceEvent,
}));

vi.mock('@/lib/fileExtractor', () => ({
  extractTextFromFile: vi.fn(),
}));

vi.mock('@/lib/agents/file_processing', () => ({
  processFileContent: vi.fn(),
}));

vi.mock('@/lib/agents/fund_update_processing', async () => {
  const actual = await vi.importActual<any>('@/lib/agents/fund_update_processing');
  return {
    ...actual,
    processFundUpdateContent: vi.fn(),
  };
});

vi.mock('@/lib/agents/fund_update_processing/llmExtractor', () => ({
  extractFundUpdateProposal: vi.fn(),
}));

import { downloadFile, getSignedUrl, deleteFile } from '@/lib/s3';
import { extractTextFromFile } from '@/lib/fileExtractor';
import { processFileContent } from '@/lib/agents/file_processing';
import { processFundUpdateContent } from '@/lib/agents/fund_update_processing';

afterEach(() => vi.clearAllMocks());

type FileRow = Tables<'files'>;
type CriteriaRow = Tables<'criterias'>;
type ScreeningRow = Tables<'screenings'>;

function makeFile(overrides: Partial<FileRow> = {}): FileRow {
  return {
    id: 'file-1',
    file_name: 'report.pdf',
    file_link: 'uploads/report.pdf',
    raw_notes: null,
    structured_notes: null,
    tags: [],
    // Most service-level fixtures exercise the review/approve path. Tests for
    // ingestion lifecycle states override this explicitly.
    processing_status: 'awaiting_review',
    matched_companies: [],
    file_date: null,
    file_type: 'other',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as FileRow;
}

function makeCompany(overrides: Partial<Tables<'companies'>> = {}): Tables<'companies'> {
  return {
    id: 'company-1',
    target: 'Acme Corp',
    project_name: null,
    segment: null,
    segment_related_offerings: null,
    company_focus: null,
    website: null,
    watchlist_status: null,
    comments: null,
    ownership: null,
    geography: null,
    remarks: null,
    pipeline_stage: 'L0',
    source: 'inbound',
    thesis_content: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as unknown as Tables<'companies'>;
}

function makeCriteria(id: string, investmentThesisId: string | null = null): CriteriaRow {
  return {
    id,
    name: `Criteria ${id}`,
    prompt: `Prompt for ${id}`,
    investment_thesis_id: investmentThesisId,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as CriteriaRow;
}

function makeScreening(id: string): ScreeningRow {
  return {
    id,
    company_id: 'company-1',
    criteria_id: 'criteria-1',
    state: 'pending',
    result: null,
    remarks: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as ScreeningRow;
}

function makeMockDb(): DbClient {
  const mock: any = {
    transaction: async (cb: (tx: any) => Promise<any>) => cb(mock),
    execute: vi.fn().mockResolvedValue([]),
  };
  return mock as unknown as DbClient;
}

function makeFileRepoStub(): FileRepository {
  const stub: any = {
    findById: vi.fn(),
    findLinkAndNameById: vi.fn(),
    findAll: vi.fn(),
    listPaginated: vi.fn(),
    countsByType: vi.fn(),
    findFirstByName: vi.fn().mockResolvedValue(null),
    insert: vi.fn(),
    update: vi.fn(),
    updatePartial: vi.fn(),
    delete: vi.fn(),
    searchForAgent: vi.fn(),
  };
  stub.findByIdForUpdate = vi.fn().mockImplementation((id: string, executor?: any) => stub.findById(id, executor));
  return stub as unknown as FileRepository;
}

function makeCriteriaRepoStub(): CriteriaRepository {
  return {
    findAll: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as CriteriaRepository;
}

function makeScreeningRepoStub(): ScreeningRepository {
  return {
    insert: vi.fn(),
    update: vi.fn(),
    findAllWithRelations: vi.fn(),
    upsertOrReset: vi.fn(),
  } as unknown as ScreeningRepository;
}

function makeCompanyFinancialRepoStub(): CompanyFinancialRepository {
  return {
    findByCompany: vi.fn().mockResolvedValue([]),
    findByCompanyAndYear: vi.fn(),
    findByCompaniesAndYears: vi.fn(),
    upsert: vi.fn(),
    bulkUpsertForCompany: vi.fn(),
  } as unknown as CompanyFinancialRepository;
}

function makeCompanyFxAdjustmentRepoStub(): CompanyFxAdjustmentRepository {
  return {
    findByCompany: vi.fn().mockResolvedValue([]),
    bulkUpsertForCompany: vi.fn(),
  } as unknown as CompanyFxAdjustmentRepository;
}

function makeUserWorkspaceRepoStub(): UserWorkspaceRepository {
  return {
    // No test exercises the multi-workspace mailbox fan-out (none pass
    // enteredByEmail), so resolveTargetWorkspaceIds never calls this — it's a
    // pure constructor placeholder. Non-empty return matches the "mailbox is
    // watched by workspace-1" convention if a future test wires it up.
    findWorkspaceIdsBySyncedEmail: vi.fn().mockResolvedValue(['workspace-1']),
    findByUserId: vi.fn(),
    findByWorkspaceId: vi.fn(),
    insert: vi.fn(),
  } as unknown as UserWorkspaceRepository;
}

function makeCompanyAnalysisServiceStub(): CompanyAnalysisService {
  return {
    dispatch: vi.fn(),
    findByCompanyId: vi.fn(),
    delete: vi.fn(),
  } as unknown as CompanyAnalysisService;
}

function makeAIScreeningServiceStub(): AIScreeningService {
  return {
    enqueue: vi.fn().mockResolvedValue({
      queued: [],
      alreadyQueued: [],
      nothingToScreen: [],
      prepared: new Map(),
    }),
  } as unknown as AIScreeningService;
}

function makeCompanyServiceStub(): CompanyService {
  return {
    findById: vi.fn().mockResolvedValue(makeCompany()),
    findByNameFuzzy: vi.fn().mockResolvedValue(null),
    findBestFuzzyMatch: vi.fn().mockResolvedValue(null),
    createFromDTO: vi.fn().mockResolvedValue({ id: 'company-new' }),
    markPossibleDuplicate: vi.fn().mockResolvedValue(undefined),
    updateFromDTO: vi.fn().mockResolvedValue({ id: 'company-1' }),
    listIdAndTargetPage: vi.fn(),
    // The real default rules (every field required).
    missingPipelineFields: vi.fn(async (c: PipelineEntryCompanyInput) => getMissingPipelineFields(c)),
  } as unknown as CompanyService;
}

function makeService(overrides: {
  db?: DbClient;
  fileRepo?: FileRepository;
  companyAnalysisService?: CompanyAnalysisService;
  aiScreeningService?: AIScreeningService;
  criteriaRepo?: CriteriaRepository;
  screeningRepo?: ScreeningRepository;
  companyFinancialRepo?: CompanyFinancialRepository;
  companyService?: CompanyService;
  companyFxAdjustmentRepo?: CompanyFxAdjustmentRepository;
} = {}) {
  return new FileService(
    overrides.db ?? makeMockDb(),
    'workspace-1',
    overrides.fileRepo ?? makeFileRepoStub(),
    overrides.companyAnalysisService ?? makeCompanyAnalysisServiceStub(),
    overrides.aiScreeningService ?? makeAIScreeningServiceStub(),
    overrides.criteriaRepo ?? makeCriteriaRepoStub(),
    overrides.screeningRepo ?? makeScreeningRepoStub(),
    overrides.companyFinancialRepo ?? makeCompanyFinancialRepoStub(),
    overrides.companyService ?? makeCompanyServiceStub(),
    overrides.companyFxAdjustmentRepo ?? makeCompanyFxAdjustmentRepoStub(),
    makeUserWorkspaceRepoStub(),
  );
}

describe('FileService.createCompanyFromFile', () => {
  let fileRepo: FileRepository;
  let companyService: CompanyService;
  let companyFinancialRepo: CompanyFinancialRepository;
  let companyFxAdjustmentRepo: CompanyFxAdjustmentRepository;
  let companyAnalysisService: CompanyAnalysisService;
  let service: FileService;

  beforeEach(() => {
    fileRepo = makeFileRepoStub();
    companyService = makeCompanyServiceStub();
    companyFinancialRepo = makeCompanyFinancialRepoStub();
    companyFxAdjustmentRepo = makeCompanyFxAdjustmentRepoStub();
    companyAnalysisService = makeCompanyAnalysisServiceStub();
    // Constructed directly with a null db (not via `makeService`, whose `??`
    // default would substitute a transaction-capable mock): with no
    // `transaction` on the client, `withCompanyNameLock` runs its callback
    // against the injected CompanyService stub rather than building a
    // transaction-bound one the test can't observe.
    service = new FileService(
      null as unknown as DbClient,
      'workspace-1',
      fileRepo,
      companyAnalysisService,
      makeAIScreeningServiceStub(),
      makeCriteriaRepoStub(),
      makeScreeningRepoStub(),
      companyFinancialRepo,
      companyService,
      companyFxAdjustmentRepo,
      makeUserWorkspaceRepoStub(),
    );
    vi.mocked(fileRepo.update).mockImplementation(async (_id, updates) =>
      makeFile({ ...updates } as Partial<FileRow>),
    );
    vi.mocked(companyAnalysisService.dispatch).mockResolvedValue(undefined as never);
  });

  it('creates an unreviewed company from a non-deal-target file (MoM)', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({
        id: 'file-mom',
        file_type: 'mom',
        structured_notes: JSON.stringify({
          matched_companies: [{ name: 'Helios Energy' }],
        }),
        matched_companies: [{ name: 'Helios Energy' }] as never,
      }),
    );
    vi.mocked(companyService.createFromDTO).mockResolvedValue(
      makeCompany({ id: 'company-new', target: 'Helios Energy' }) as never,
    );
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ id: 'company-new', target: 'Helios Energy' }),
    );

    const result = await service.createCompanyFromFile('file-mom');

    expect(result.created).toBe(true);
    const [dto, reason] = vi.mocked(companyService.createFromDTO).mock.calls[0];
    expect(dto).toMatchObject({
      pipeline_stage: 'unreviewed',
      target: 'Helios Energy',
      // doc_type records the document the company was sourced from.
      doc_type: 'mom',
    });
    expect(reason).toBe('created_from_file:file-mom');
  });

  it('seeds the company from the extracted deal-target entry when the file has one', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({
        id: 'file-pros',
        file_type: 'prospectus',
        structured_notes: JSON.stringify({
          companies: [
            {
              company_name: 'Acme Corp',
              segment: 'Industrials',
              geography: 'Indonesia',
              financials: [
                {
                  fiscal_year: 2019,
                  revenue_usd_mn: 12,
                  ebitda_usd_mn: null,
                  ev_usd_mn: null,
                  ebitda_margin: null,
                  ev_ebitda: null,
                  revenue_cagr_vs_prior: null,
                },
              ],
            },
          ],
        }),
      }),
    );
    vi.mocked(companyService.createFromDTO).mockResolvedValue(
      makeCompany({ id: 'company-new', target: 'Acme Corp' }) as never,
    );

    await service.createCompanyFromFile('file-pros');

    expect(vi.mocked(companyService.createFromDTO).mock.calls[0][0]).toMatchObject({
      target: 'Acme Corp',
      segment: 'Industrials',
      geography: 'Indonesia',
    });
    // FY2019 is outside the legacy flat DTO's 2021–2025 window, so it can only
    // reach the company through the normalized ledger.
    expect(companyFinancialRepo.bulkUpsertForCompany).toHaveBeenCalledWith('company-new', [
      expect.objectContaining({ fiscal_year: 2019, revenue_usd_mn: 12 }),
    ]);
  });

  it('carries a financial statement\'s issuer and figures into the new company', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({
        id: 'file-fs',
        file_type: 'financial_statement',
        structured_notes: JSON.stringify({
          financial_statement_summary: {
            company_name: 'Borneo Mining',
            financials: [
              {
                fiscal_year: 2023,
                revenue_usd_mn: 88,
                ebitda_usd_mn: 20,
                ev_usd_mn: null,
                ebitda_margin: null,
                ev_ebitda: null,
                revenue_cagr_vs_prior: null,
              },
            ],
          },
        }),
      }),
    );
    vi.mocked(companyService.createFromDTO).mockResolvedValue(
      makeCompany({ id: 'company-new', target: 'Borneo Mining' }) as never,
    );

    const result = await service.createCompanyFromFile('file-fs');

    expect(result.created).toBe(true);
    expect(vi.mocked(companyService.createFromDTO).mock.calls[0][0]).toMatchObject({
      target: 'Borneo Mining',
      doc_type: 'financial_statement',
    });
    expect(companyFinancialRepo.bulkUpsertForCompany).toHaveBeenCalledWith('company-new', [
      expect.objectContaining({ fiscal_year: 2023, revenue_usd_mn: 88 }),
    ]);
  });

  it('prefers the caller-supplied name over the extracted candidate', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({
        id: 'file-1',
        file_type: 'bond_issuance',
        structured_notes: JSON.stringify({
          companies: [{ company_name: 'Extracted Co' }],
        }),
      }),
    );
    vi.mocked(companyService.createFromDTO).mockResolvedValue(
      makeCompany({ id: 'company-new', target: 'Typed Co' }) as never,
    );

    await service.createCompanyFromFile('file-1', { name: '  Typed Co  ' });

    // The typed name matches no extracted entry, so nothing from the unrelated
    // "Extracted Co" entry may leak into the new row.
    expect(vi.mocked(companyService.createFromDTO).mock.calls[0][0]).toMatchObject({
      target: 'Typed Co',
    });
    expect(
      vi.mocked(companyService.createFromDTO).mock.calls[0][0].project_name,
    ).toBeUndefined();
  });

  it('links an existing company instead of creating a near-duplicate', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_type: 'mom', matched_companies: [] }),
    );
    vi.mocked(companyService.findByNameFuzzy).mockResolvedValue(
      makeCompany({ id: 'company-existing', target: 'Acme Corp' }) as never,
    );
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ id: 'company-existing', target: 'Acme Corp' }),
    );

    const result = await service.createCompanyFromFile('file-1', { name: 'Acme Corp' });

    expect(result.created).toBe(false);
    expect(companyService.createFromDTO).not.toHaveBeenCalled();
    expect(vi.mocked(fileRepo.update).mock.calls[0][1].matched_companies).toEqual([
      expect.objectContaining({ id: 'company-existing', type: 'company' }),
    ]);
  });

  it('links the new company to the file and dispatches analysis', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_type: 'mom', matched_companies: [] }),
    );
    vi.mocked(companyService.createFromDTO).mockResolvedValue(
      makeCompany({ id: 'company-new', target: 'Helios Energy' }) as never,
    );
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ id: 'company-new', target: 'Helios Energy' }),
    );

    await service.createCompanyFromFile('file-1', { name: 'Helios Energy' });

    expect(vi.mocked(fileRepo.update).mock.calls[0][1].matched_companies).toEqual([
      expect.objectContaining({ id: 'company-new', name: 'Helios Energy' }),
    ]);
    expect(companyAnalysisService.dispatch).toHaveBeenCalledWith({
      companyId: 'company-new',
      source: 'mom',
    });
  });

  it('rejects a file with no extractable name and no caller-supplied name', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_type: 'other', structured_notes: null, matched_companies: [] }),
    );

    await expect(service.createCompanyFromFile('file-1')).rejects.toBeInstanceOf(
      FileCompanyNameRequiredError,
    );
    expect(companyService.createFromDTO).not.toHaveBeenCalled();
  });

  it('ignores name chips that are already pipeline companies', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({
        id: 'file-1',
        file_type: 'other',
        matched_companies: [
          { id: 'company-1', name: 'Already Linked', type: 'company' },
          { name: 'Only Suggested' },
        ] as never,
      }),
    );
    vi.mocked(companyService.createFromDTO).mockResolvedValue(
      makeCompany({ id: 'company-new', target: 'Only Suggested' }) as never,
    );

    await service.createCompanyFromFile('file-1');

    expect(vi.mocked(companyService.createFromDTO).mock.calls[0][0]).toMatchObject({
      target: 'Only Suggested',
    });
  });

  it('rejects a generic document heading as a company name', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({
        id: 'file-1',
        file_type: 'other',
        matched_companies: [{ name: 'Executive Summary' }] as never,
      }),
    );

    await expect(service.createCompanyFromFile('file-1')).rejects.toBeInstanceOf(
      FileCompanyNameRequiredError,
    );
  });
});

describe('FileService.processUpload', () => {
  let fileRepo: FileRepository;
  let companyAnalysisService: CompanyAnalysisService;
  let aiScreeningService: AIScreeningService;
  let criteriaRepo: CriteriaRepository;
  let screeningRepo: ScreeningRepository;
  let companyFinancialRepo: CompanyFinancialRepository;
  let companyService: CompanyService;
  let service: FileService;

  beforeEach(() => {
    fileRepo = makeFileRepoStub();
    companyAnalysisService = makeCompanyAnalysisServiceStub();
    aiScreeningService = makeAIScreeningServiceStub();
    criteriaRepo = makeCriteriaRepoStub();
    screeningRepo = makeScreeningRepoStub();
    companyFinancialRepo = makeCompanyFinancialRepoStub();
    companyService = makeCompanyServiceStub();
    service = new FileService(
      null as unknown as DbClient,
      'workspace-1',
      fileRepo,
      companyAnalysisService,
      aiScreeningService,
      criteriaRepo,
      screeningRepo,
      companyFinancialRepo,
      companyService,
      makeCompanyFxAdjustmentRepoStub(),
      makeUserWorkspaceRepoStub(),
    );

    vi.mocked(downloadFile).mockResolvedValue(Buffer.from('content'));
    vi.mocked(getSignedUrl).mockResolvedValue('https://signed-url');
    vi.mocked(fileRepo.insert).mockResolvedValue(makeFile({ id: 'file-1', processing_status: 'processing' }));
    vi.mocked(fileRepo.findById).mockResolvedValue(makeFile({ id: 'file-1', processing_status: 'completed' }));
    vi.mocked(processFileContent).mockResolvedValue(null);
    vi.mocked(processFundUpdateContent).mockResolvedValue(null as any);
    vi.mocked(criteriaRepo.findAll).mockResolvedValue([]);
  });

  it('skips insert and returns the existing file when the same filename was already uploaded', async () => {
    const existing = makeFile({
      id: 'file-existing',
      file_name: 'report.pdf',
      file_link: 'uploads/original.pdf',
      processing_status: 'completed',
    });
    vi.mocked(fileRepo.findFirstByName).mockResolvedValue(existing);
    vi.mocked(deleteFile).mockResolvedValue(undefined as never);

    const result = await service.processUpload('uploads/copy.pdf', 'report.pdf', 'application/pdf');

    expect(fileRepo.findFirstByName).toHaveBeenCalledWith('report.pdf');
    expect(fileRepo.insert).not.toHaveBeenCalled();
    expect(downloadFile).not.toHaveBeenCalled();
    expect(processFileContent).not.toHaveBeenCalled();
    // The freshly uploaded duplicate S3 object is cleaned up.
    expect(deleteFile).toHaveBeenCalledWith('uploads/copy.pdf');
    expect(getSignedUrl).toHaveBeenCalledWith('uploads/original.pdf');
    expect(result).toMatchObject({ id: 'file-existing', duplicate: true, signed_url: 'https://signed-url' });
  });

  it('does not delete the S3 object when the duplicate points at the same key', async () => {
    const existing = makeFile({ id: 'file-existing', file_link: 'uploads/report.pdf' });
    vi.mocked(fileRepo.findFirstByName).mockResolvedValue(existing);

    await service.processUpload('uploads/report.pdf', 'report.pdf', 'application/pdf');

    expect(deleteFile).not.toHaveBeenCalled();
  });

  it('skips text extraction for PDF files', async () => {
    await service.processUpload('uploads/report.pdf', 'report.pdf', 'application/pdf');

    expect(extractTextFromFile).not.toHaveBeenCalled();
  });

  it('skips text extraction when filename ends with .pdf regardless of content-type', async () => {
    await service.processUpload('uploads/report.pdf', 'report.pdf', '');

    expect(extractTextFromFile).not.toHaveBeenCalled();
  });

  it('calls extractTextFromFile for non-PDF files', async () => {
    vi.mocked(extractTextFromFile).mockResolvedValue('extracted text');

    await service.processUpload('uploads/notes.docx', 'notes.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');

    expect(extractTextFromFile).toHaveBeenCalledOnce();
  });

  it('auto-completes non-prospectus files (no HITL gate)', async () => {
    await service.processUpload('uploads/report.pdf', 'report.pdf', 'application/pdf');

    // file_type defaults to 'other' when no override and processFileContent
    // returns null — Option A skips the review gate for these.
    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({ processing_status: 'completed' }),
    );
  });

  it('stores fixed drop_reason code for origin_email other (no classifier summary)', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'other',
      summary: 'Private personal tax return for John Doe SSN 123-45-6789',
    } as never);
    vi.mocked(deleteFile).mockResolvedValue(undefined as never);
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', processing_status: 'dropped', drop_reason: 'afd_classified_other' }),
    );

    const result = await service.processUpload(
      'uploads/personal.pdf',
      'personal.pdf',
      'application/pdf',
      undefined,
      undefined,
      true, // origin_email
    );

    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({
        processing_status: 'dropped',
        file_type: 'other',
        drop_reason: 'afd_classified_other',
      }),
    );
    const dropCall = vi
      .mocked(fileRepo.updatePartial)
      .mock.calls.find((c) => (c[1] as { drop_reason?: string }).drop_reason);
    expect(String((dropCall?.[1] as { drop_reason?: string }).drop_reason)).toBe(
      'afd_classified_other',
    );
    expect(String((dropCall?.[1] as { drop_reason?: string }).drop_reason)).not.toContain(
      'Private personal',
    );
    expect(deleteFile).toHaveBeenCalledWith('uploads/personal.pdf');
    expect(result).toMatchObject({ dropped: true });
  });

  it('completes prospectus files without a review gate', async () => {
    vi.mocked(processFileContent).mockResolvedValue({ file_type: 'prospectus' } as never);

    await service.processUpload('uploads/report.pdf', 'report.pdf', 'application/pdf');

    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({ processing_status: 'completed' }),
    );
  });

  it('completes files when fileTypeOverride is prospectus', async () => {
    await service.processUpload(
      'uploads/report.pdf',
      'report.pdf',
      'application/pdf',
      undefined,
      'prospectus',
    );

    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({ processing_status: 'completed' }),
    );
  });

  it('marks status as failed when processFileContent throws', async () => {
    vi.mocked(processFileContent).mockRejectedValue(new Error('AI error'));

    await service.processUpload('uploads/report.pdf', 'report.pdf', 'application/pdf');

    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({ processing_status: 'failed' }),
    );
  });

  it('does not dispatch company analysis when no company is created', async () => {
    vi.mocked(processFileContent).mockResolvedValue({ file_type: 'prospectus' } as never);

    await service.processUpload('uploads/report.pdf', 'report.pdf', 'application/pdf');

    expect(companyAnalysisService.dispatch).not.toHaveBeenCalled();
  });

  it('does not dispatch AI screening when no company is created', async () => {
    vi.mocked(processFileContent).mockResolvedValue({ file_type: 'prospectus' } as never);
    vi.mocked(criteriaRepo.findAll).mockResolvedValue([makeCriteria('criteria-1')]);

    await service.processUpload('uploads/report.pdf', 'report.pdf', 'application/pdf');

    expect(aiScreeningService.enqueue).not.toHaveBeenCalled();
  });

  it('returns signed URL with file data', async () => {
    const result = await service.processUpload('uploads/report.pdf', 'report.pdf', 'application/pdf');

    expect(getSignedUrl).toHaveBeenCalledWith('uploads/report.pdf');
    expect(result).toMatchObject({ signed_url: 'https://signed-url' });
  });

  it('forwards fileTypeOverride to processFileContent and persists it as file_type', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'mom',
    } as never);

    await service.processUpload(
      'uploads/notes.pdf',
      'notes.pdf',
      'application/pdf',
      undefined,
      'mom',
    );

    // fileTypeOverride is now arg index 4 (rawText=0, buffer=1, fileType=2, rawNotes=3, fileTypeOverride=4)
    const lastCallArgs = vi.mocked(processFileContent).mock.calls.at(-1);
    expect(lastCallArgs?.[4]).toBe('mom');
    expect(fileRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ file_type: 'mom' }),
    );
    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({ file_type: 'mom', processing_status: 'completed' }),
    );
  });

  it('lets fileTypeOverride win over the agent-detected file_type', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
    } as never);

    await service.processUpload(
      'uploads/notes.pdf',
      'notes.pdf',
      'application/pdf',
      undefined,
      'mom',
    );

    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({ file_type: 'mom' }),
    );
  });

  it('falls back to the agent-detected file_type when no override is given', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
    } as never);

    await service.processUpload('uploads/notes.pdf', 'notes.pdf', 'application/pdf');

    expect(fileRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ file_type: 'other' }),
    );
    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({ file_type: 'prospectus' }),
    );
  });

  it('dispatches fund_update_extraction job when the general agent identifies the file as fund_updates', async () => {
    const mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ jobId: 'job-123' }),
    };
    service.setJobDispatcher(mockDispatcher as any);

    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'fund_updates',
      summary: 'Some summary',
    } as never);

    const result = await service.processUpload(
      'uploads/fund_report.xlsx',
      'fund_report.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );

    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fund_update_extraction',
        payload: expect.objectContaining({ fileId: 'file-1' }),
      }),
    );
    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({
        file_type: 'fund_updates',
        processing_status: 'processing',
      }),
    );
    expect(result).toMatchObject({
      jobId: 'job-123',
    });
  });

  it('skips extractTextFromFile and dispatches fund_update_extraction job for explicit fund_updates Excel upload', async () => {
    const mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ jobId: 'job-123' }),
    };
    service.setJobDispatcher(mockDispatcher as any);

    const result = await service.processUpload(
      'uploads/fund_report.xlsx',
      'fund_report.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      undefined,
      'fund_updates',
    );

    expect(extractTextFromFile).not.toHaveBeenCalled();
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fund_update_extraction',
        payload: expect.objectContaining({ fileId: 'file-1' }),
      }),
    );
    expect(result).toMatchObject({
      jobId: 'job-123',
    });
  });

  it('marks secondary workspace file rows failed with explicit unsupported fan-out error on async fund_updates Excel upload', async () => {
    const userWorkspaceRepo = makeUserWorkspaceRepoStub();
    vi.mocked(userWorkspaceRepo.findWorkspaceIdsBySyncedEmail).mockResolvedValue(['workspace-1', 'workspace-2']);

    const customService = new FileService(
      null as unknown as DbClient,
      'workspace-1',
      fileRepo,
      companyAnalysisService,
      aiScreeningService,
      criteriaRepo,
      screeningRepo,
      companyFinancialRepo,
      companyService,
      makeCompanyFxAdjustmentRepoStub(),
      userWorkspaceRepo,
    );

    const mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ jobId: 'job-async-123' }),
    };
    customService.setJobDispatcher(mockDispatcher as any);

    const insertSpy = vi.spyOn(FileRepository.prototype, 'insert').mockResolvedValue(
      makeFile({ id: 'file-secondary-1', workspace_id: 'workspace-2', processing_status: 'processing' }),
    );
    const updatePartialSpy = vi.spyOn(FileRepository.prototype, 'updatePartial').mockResolvedValue(undefined);

    const result = await customService.processUpload(
      'uploads/fund_report.xlsx',
      'fund_report.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      undefined,
      'fund_updates',
      false,
      undefined,
      'custodian@corp.com',
    );

    expect(result).toMatchObject({
      jobId: 'job-async-123',
      asyncSecondaryWorkspacesSkipped: true,
    });
    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({ processing_status: 'processing' }),
    );
    expect(updatePartialSpy).toHaveBeenCalledWith(
      'file-secondary-1',
      expect.objectContaining({
        processing_status: 'failed',
        raw_notes: 'Async fund update extraction does not support secondary workspace fan-out',
      }),
    );

    insertSpy.mockRestore();
    updatePartialSpy.mockRestore();
  });

  it('marks primary file failed and throws when jobDispatcher is not set for async fund_updates Excel upload', async () => {
    await expect(
      service.processUpload(
        'uploads/fund_report.xlsx',
        'fund_report.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        undefined,
        'fund_updates',
      ),
    ).rejects.toThrow('Failed to dispatch async fund update extraction job');

    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({
        processing_status: 'failed',
        raw_notes: expect.stringContaining('Failed to dispatch async fund update extraction job'),
      }),
    );
  });

  it('marks primary file failed and throws when jobDispatcher.dispatch throws on async fund_updates Excel upload', async () => {
    const mockDispatcher = {
      dispatch: vi.fn().mockRejectedValue(new Error('Dispatcher queue full')),
    };
    service.setJobDispatcher(mockDispatcher as any);

    await expect(
      service.processUpload(
        'uploads/fund_report.xlsx',
        'fund_report.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        undefined,
        'fund_updates',
      ),
    ).rejects.toThrow('Failed to dispatch async fund update extraction job');

    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({
        processing_status: 'failed',
        raw_notes: expect.stringContaining('Failed to dispatch async fund update extraction job'),
      }),
    );
  });

  it('falls through to dispatch when JobRepository.findByTypeAndPayload throws during async upload', async () => {
    const { JobRepository } = await import('@/lib/repositories');
    const findSpy = vi.spyOn(JobRepository.prototype, 'findByTypeAndPayload').mockRejectedValueOnce(
      new Error('DB connection refused'),
    );

    const mockDbClient = {} as DbClient;
    const customService = new FileService(
      mockDbClient,
      'workspace-1',
      fileRepo,
      companyAnalysisService,
      aiScreeningService,
      criteriaRepo,
      screeningRepo,
      companyFinancialRepo,
      companyService,
      makeCompanyFxAdjustmentRepoStub(),
      makeUserWorkspaceRepoStub(),
    );
    const mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ jobId: 'job-dispatched-after-query-fail' }),
    };
    customService.setJobDispatcher(mockDispatcher as any);

    const result = await customService.processUpload(
      'uploads/fund_report.xlsx',
      'fund_report.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      undefined,
      'fund_updates',
    );

    expect(mockDispatcher.dispatch).toHaveBeenCalled();
    expect(result).toMatchObject({ jobId: 'job-dispatched-after-query-fail' });
    findSpy.mockRestore();
  });

  it('routes explicit fund_updates PDF upload synchronously via processFundUpdateContent without dispatching job', async () => {
    const mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ jobId: 'job-123' }),
    };
    service.setJobDispatcher(mockDispatcher as any);

    vi.mocked(processFundUpdateContent).mockResolvedValue({
      file_type: 'fund_updates',
      parser: 'llm_fallback',
      summary: 'PDF Fund update summary',
      tags: ['Fund Update'],
      fund_update_proposal: null,
    } as any);

    const result = await service.processUpload(
      'uploads/fund_report.pdf',
      'fund_report.pdf',
      'application/pdf',
      undefined,
      'fund_updates',
    );

    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    expect(processFundUpdateContent).toHaveBeenCalled();
    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({
        file_type: 'fund_updates',
        processing_status: 'completed',
      }),
    );
    expect((result as any).jobId).toBeUndefined();
  });

  it('routes auto-classified fund_updates PDF upload synchronously via processFundUpdateContent without dispatching job', async () => {
    const mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ jobId: 'job-123' }),
    };
    service.setJobDispatcher(mockDispatcher as any);

    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'fund_updates',
      summary: 'Auto-classified PDF fund update',
    } as never);

    vi.mocked(processFundUpdateContent).mockResolvedValue({
      file_type: 'fund_updates',
      parser: 'llm_fallback',
      summary: 'PDF Fund update extracted',
      tags: ['Fund Update'],
      fund_update_proposal: null,
    } as any);

    const result = await service.processUpload(
      'uploads/fund_report.pdf',
      'fund_report.pdf',
      'application/pdf',
    );

    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    expect(processFundUpdateContent).toHaveBeenCalled();
    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({
        file_type: 'fund_updates',
        processing_status: 'completed',
      }),
    );
    expect((result as any).jobId).toBeUndefined();
  });

  it('honors a fileTypeOverride of "other"', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
    } as never);

    await service.processUpload(
      'uploads/notes.pdf',
      'notes.pdf',
      'application/pdf',
      undefined,
      'other',
    );

    const lastCallArgs = vi.mocked(processFileContent).mock.calls.at(-1);
    expect(lastCallArgs?.[4]).toBe('other');
    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({ file_type: 'other' }),
    );
  });

  it('queues the file for HITL review when the extracted name matches a company in the L0–L5 pipeline', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
      matched_companies: [{ id: 'company-existing', type: 'company' }],
      prospectus_summary: {
        company_name: 'Acme Corp',
        segment: 'Industrial Tech',
      },
    } as never);
    vi.mocked(companyService.findByNameFuzzy).mockResolvedValue(
      makeCompany({ id: 'company-existing', target: 'Acme Corp', pipeline_stage: 'L2' }) as never,
    );

    await service.processUpload(
      'uploads/teaser.pdf',
      'teaser.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
      'Goldman Sachs',
    );

    expect(companyService.findByNameFuzzy).toHaveBeenCalledWith('Acme Corp');
    // In-pipeline companies are never auto-modified — the user reviews the
    // changes via the HITL dialog instead.
    expect(companyService.createFromDTO).not.toHaveBeenCalled();
    expect(companyService.updateFromDTO).not.toHaveBeenCalled();
    expect(companyFinancialRepo.bulkUpsertForCompany).not.toHaveBeenCalled();
    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({
        matched_companies: expect.arrayContaining([
          expect.objectContaining({ id: 'company-existing' }),
        ]),
        processing_status: 'awaiting_review',
      }),
    );
  });

  it('falls back to the Levenshtein matcher when the substring match misses, and skips create', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
      prospectus_summary: {
        company_name: 'Acme Crop', // typo of an existing "Acme Corp"
        segment: 'Industrial Tech',
      },
    } as never);
    // Substring gate misses the typo...
    vi.mocked(companyService.findByNameFuzzy).mockResolvedValue(null as never);
    // ...but the Levenshtein fallback resolves the existing company.
    vi.mocked(companyService.findBestFuzzyMatch).mockResolvedValue(
      makeCompany({ id: 'company-existing', target: 'Acme Corp', pipeline_stage: 'L2' }) as never,
    );

    await service.processUpload('uploads/teaser.pdf', 'teaser.pdf', 'application/pdf');

    expect(companyService.findByNameFuzzy).toHaveBeenCalledWith('Acme Crop');
    expect(companyService.findBestFuzzyMatch).toHaveBeenCalledWith('Acme Crop');
    // Matched an existing company — no duplicate is created.
    expect(companyService.createFromDTO).not.toHaveBeenCalled();
  });

  it('auto-accepts the extracted changes when the match is NOT in the L0–L5 pipeline', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
      prospectus_summary: {
        company_name: 'Acme Corp',
        segment: 'Industrial Tech',
        website: 'https://acme.example',
        financials: [
          { fiscal_year: 2024, revenue_usd_mn: 120, ebitda_usd_mn: 30, ev_usd_mn: null, ebitda_margin: null, ev_ebitda: null, revenue_cagr_vs_prior: null },
        ],
      },
    } as never);
    vi.mocked(companyService.findByNameFuzzy).mockResolvedValue(
      makeCompany({ id: 'company-existing', target: 'Acme Corp', pipeline_stage: 'unreviewed' }) as never,
    );
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ id: 'company-existing', target: 'Acme Corp', pipeline_stage: 'unreviewed' }),
    );
    vi.mocked(companyAnalysisService.dispatch).mockResolvedValue({ runId: 'run-1' } as never);

    await service.processUpload('uploads/teaser.pdf', 'teaser.pdf', 'application/pdf');

    // No review gate: the pre-pipeline company is enriched in place.
    expect(companyService.updateFromDTO).toHaveBeenCalledWith(
      'company-existing',
      expect.objectContaining({ segment: 'Industrial Tech', website: 'https://acme.example' }),
      'auto_enriched_from_file:file-1',
    );
    expect(companyFinancialRepo.bulkUpsertForCompany).toHaveBeenCalledWith(
      'company-existing',
      [expect.objectContaining({ fiscal_year: 2024, revenue_usd_mn: 120 })],
    );
    expect(companyService.createFromDTO).not.toHaveBeenCalled();
    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({ processing_status: 'completed' }),
    );
    // Enriched companies get the same analysis dispatch as created ones.
    expect(companyAnalysisService.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-existing' }),
    );
  });

  it('auto-enrich fills only empty fields and only missing fiscal years', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
      prospectus_summary: {
        company_name: 'Acme Corp',
        segment: 'NEW segment (must not overwrite)',
        ownership: 'Founder-owned',
        financials: [
          { fiscal_year: 2023, revenue_usd_mn: 100, ebitda_usd_mn: null, ev_usd_mn: null, ebitda_margin: null, ev_ebitda: null, revenue_cagr_vs_prior: null },
          { fiscal_year: 2024, revenue_usd_mn: 120, ebitda_usd_mn: null, ev_usd_mn: null, ebitda_margin: null, ev_ebitda: null, revenue_cagr_vs_prior: null },
        ],
      },
    } as never);
    vi.mocked(companyService.findByNameFuzzy).mockResolvedValue(
      makeCompany({
        id: 'company-existing',
        target: 'Acme Corp',
        pipeline_stage: 'unreviewed',
        segment: 'Existing segment',
      }) as never,
    );
    // 2023 already exists in the DB — only 2024 may be inserted.
    vi.mocked(companyFinancialRepo.findByCompany).mockResolvedValue([
      { fiscal_year: 2023 } as never,
    ]);
    vi.mocked(companyAnalysisService.dispatch).mockResolvedValue({ runId: 'run-1' } as never);

    await service.processUpload('uploads/teaser.pdf', 'teaser.pdf', 'application/pdf');

    expect(companyService.updateFromDTO).toHaveBeenCalledWith(
      'company-existing',
      { ownership: 'Founder-owned' },
      'auto_enriched_from_file:file-1',
    );
    expect(companyFinancialRepo.bulkUpsertForCompany).toHaveBeenCalledWith(
      'company-existing',
      [expect.objectContaining({ fiscal_year: 2024 })],
    );
  });

  it('does not enrich or dispatch when the pre-pipeline match adds nothing new', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
      prospectus_summary: {
        company_name: 'Acme Corp',
        segment: 'Existing segment',
      },
    } as never);
    vi.mocked(companyService.findByNameFuzzy).mockResolvedValue(
      makeCompany({
        id: 'company-existing',
        target: 'Acme Corp',
        pipeline_stage: 'unreviewed',
        segment: 'Existing segment',
      }) as never,
    );

    await service.processUpload('uploads/teaser.pdf', 'teaser.pdf', 'application/pdf');

    expect(companyService.updateFromDTO).not.toHaveBeenCalled();
    expect(companyFinancialRepo.bulkUpsertForCompany).not.toHaveBeenCalled();
    expect(companyAnalysisService.dispatch).not.toHaveBeenCalled();
    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({ processing_status: 'completed' }),
    );
  });

  it('lists review-flagged companies first in matched_companies so the dialog proposes them', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'shopping_list',
      companies: [
        { company_name: 'New Co' },
        { company_name: 'Pipeline Co' },
      ],
    } as never);
    vi.mocked(companyService.findByNameFuzzy).mockImplementation(async (name: string) =>
      name === 'Pipeline Co'
        ? (makeCompany({ id: 'company-pipeline', target: 'Pipeline Co', pipeline_stage: 'L3' }) as never)
        : (null as never),
    );
    vi.mocked(companyService.createFromDTO).mockResolvedValue({
      id: 'company-new',
      target: 'New Co',
    } as never);
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ id: 'company-new', target: 'New Co' }),
    );
    vi.mocked(companyAnalysisService.dispatch).mockResolvedValue({ runId: 'run-1' } as never);

    await service.processUpload('uploads/targets.pdf', 'targets.pdf', 'application/pdf', undefined, 'shopping_list');

    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({
        matched_companies: [
          expect.objectContaining({ id: 'company-pipeline' }),
          expect.objectContaining({ id: 'company-new' }),
        ],
        processing_status: 'awaiting_review',
      }),
    );
  });

  it('creates an unreviewed company when no existing company matches', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
      prospectus_summary: { company_name: 'Acme Corp' },
    } as never);
    vi.mocked(companyService.findByNameFuzzy).mockResolvedValue(null as never);
    vi.mocked(companyService.createFromDTO).mockResolvedValue({
      id: 'company-new',
      target: 'Acme Corp',
    } as never);

    await service.processUpload(
      'uploads/teaser.pdf',
      'teaser.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
      'Goldman Sachs',
    );

    expect(companyService.createFromDTO).toHaveBeenCalledWith(
      expect.objectContaining({
        target: 'Acme Corp',
        source: 'inbound',
        pipeline_stage: 'unreviewed',
        banker_source: 'Goldman Sachs',
        entered_by: null,
      }),
      'auto_created_from_file:file-1',
      { deferPendingArrival: true },
    );
  });

  it('creates one company per entry in the multi-company companies array (manual upload)', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'shopping_list',
      companies: [
        { company_name: 'Acme Corp', segment: 'Fintech' },
        { company_name: 'Beta Ltd', segment: 'Healthcare' },
      ],
      prospectus_summary: { company_name: 'Acme Corp', segment: 'Fintech' },
    } as never);
    vi.mocked(companyService.findByNameFuzzy).mockResolvedValue(null as never);
    vi.mocked(companyService.createFromDTO)
      .mockResolvedValueOnce({ id: 'company-a', target: 'Acme Corp' } as never)
      .mockResolvedValueOnce({ id: 'company-b', target: 'Beta Ltd' } as never);
    vi.mocked(companyService.findById)
      .mockResolvedValueOnce(makeCompany({ id: 'company-a', target: 'Acme Corp' }))
      .mockResolvedValueOnce(makeCompany({ id: 'company-b', target: 'Beta Ltd' }));

    // Manual upload: originEmail=false, uploader session user provided.
    await service.processUpload(
      'uploads/targets.xlsx',
      'targets.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      undefined,
      'shopping_list',
      false,
      undefined,
      undefined,
      'uploader-uuid',
    );

    expect(companyService.createFromDTO).toHaveBeenCalledTimes(2);
    expect(companyService.createFromDTO).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        target: 'Acme Corp',
        segment: 'Fintech',
        pipeline_stage: 'unreviewed',
        entered_by: 'uploader-uuid',
      }),
      'auto_created_from_file:file-1',
      { deferPendingArrival: true },
    );
    expect(companyService.createFromDTO).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ target: 'Beta Ltd', segment: 'Healthcare' }),
      'auto_created_from_file:file-1',
      { deferPendingArrival: true },
    );
    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({
        matched_companies: [
          expect.objectContaining({ id: 'company-a' }),
          expect.objectContaining({ id: 'company-b' }),
        ],
        processing_status: 'completed',
      }),
    );
  });

  it('creates only the new companies and records existing ones when a multi-company file has duplicates', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'shopping_list',
      companies: [
        { company_name: 'Acme Corp' },
        { company_name: 'Beta Ltd' },
      ],
    } as never);
    // Acme already exists; Beta does not.
    vi.mocked(companyService.findByNameFuzzy).mockImplementation(async (name: string) =>
      name === 'Acme Corp'
        ? (makeCompany({ id: 'company-existing', target: 'Acme Corp' }) as never)
        : (null as never),
    );
    vi.mocked(companyService.createFromDTO).mockResolvedValue({
      id: 'company-b',
      target: 'Beta Ltd',
    } as never);
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ id: 'company-b', target: 'Beta Ltd' }),
    );

    await service.processUpload(
      'uploads/targets.pdf',
      'targets.pdf',
      'application/pdf',
      undefined,
      'shopping_list',
    );

    expect(companyService.createFromDTO).toHaveBeenCalledTimes(1);
    expect(companyService.createFromDTO).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'Beta Ltd' }),
      'auto_created_from_file:file-1',
      { deferPendingArrival: true },
    );
    expect(companyService.updateFromDTO).not.toHaveBeenCalled();
    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({
        matched_companies: [
          expect.objectContaining({ id: 'company-existing' }),
          expect.objectContaining({ id: 'company-b' }),
        ],
      }),
    );
  });

  it('dispatches analysis and screening only for newly created companies', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
      companies: [
        { company_name: 'Acme Corp' },
        { company_name: 'Beta Ltd' },
      ],
    } as never);
    vi.mocked(companyService.findByNameFuzzy).mockImplementation(async (name: string) =>
      name === 'Acme Corp'
        ? (makeCompany({ id: 'company-existing', target: 'Acme Corp' }) as never)
        : (null as never),
    );
    vi.mocked(companyService.createFromDTO).mockResolvedValue({
      id: 'company-b',
      target: 'Beta Ltd',
    } as never);
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ id: 'company-b', target: 'Beta Ltd', matched_track_ids: ['track-1'] } as never),
    );
    vi.mocked(criteriaRepo.findAll).mockResolvedValue([makeCriteria('c-1', 'track-1')]);
    vi.mocked(screeningRepo.insert).mockResolvedValue(makeScreening('s-1'));
    vi.mocked(companyAnalysisService.dispatch).mockResolvedValue({ runId: 'run-1' } as never);

    await service.processUpload('uploads/teaser.pdf', 'teaser.pdf', 'application/pdf');

    expect(companyAnalysisService.dispatch).toHaveBeenCalledTimes(1);
    expect(companyAnalysisService.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-b', source: 'prospectus' }),
    );
    await vi.waitFor(() => {
      expect(aiScreeningService.enqueue).toHaveBeenCalledWith(['company-b'], {
        mode: 'tracks',
        force: true,
      });
    });
  });

  it('hands a newly created company to the workspace auto-scan instead of screening it', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
      prospectus_summary: { company_name: 'Beta Ltd' },
    } as never);
    vi.mocked(companyService.findByNameFuzzy).mockResolvedValue(null as never);
    vi.mocked(companyService.createFromDTO).mockResolvedValue({
      id: 'company-b',
      target: 'Beta Ltd',
    } as never);
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ id: 'company-b', target: 'Beta Ltd', matched_track_ids: ['track-1'] } as never),
    );
    vi.mocked(criteriaRepo.findAll).mockResolvedValue([makeCriteria('c-1', 'track-1')]);
    vi.mocked(companyAnalysisService.dispatch).mockResolvedValue({ runId: 'run-1' } as never);
    const onCompanyEnteredPending = vi.fn().mockResolvedValue(true);
    service.setPendingAutoScanService({ onCompanyEnteredPending } as never);

    await service.processUpload('uploads/teaser.pdf', 'teaser.pdf', 'application/pdf');

    expect(onCompanyEnteredPending).toHaveBeenCalledWith('company-b', null);
    // Screening is fire-and-forget; let it run before asserting it didn't.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(aiScreeningService.enqueue).not.toHaveBeenCalled();
  });

  it('falls back to its own screening when auto-scan is off', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
      prospectus_summary: { company_name: 'Beta Ltd' },
    } as never);
    vi.mocked(companyService.findByNameFuzzy).mockResolvedValue(null as never);
    vi.mocked(companyService.createFromDTO).mockResolvedValue({
      id: 'company-b',
      target: 'Beta Ltd',
    } as never);
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ id: 'company-b', target: 'Beta Ltd', matched_track_ids: ['track-1'] } as never),
    );
    vi.mocked(criteriaRepo.findAll).mockResolvedValue([makeCriteria('c-1', 'track-1')]);
    vi.mocked(screeningRepo.insert).mockResolvedValue(makeScreening('s-1'));
    vi.mocked(companyAnalysisService.dispatch).mockResolvedValue({ runId: 'run-1' } as never);
    service.setPendingAutoScanService({
      onCompanyEnteredPending: vi.fn().mockResolvedValue(false),
    } as never);

    await service.processUpload('uploads/teaser.pdf', 'teaser.pdf', 'application/pdf');

    await vi.waitFor(() => {
      expect(aiScreeningService.enqueue).toHaveBeenCalledWith(['company-b'], {
        mode: 'tracks',
        force: true,
      });
    });
  });

  it('does not auto-create a company from a market_study email attachment', async () => {
    // A market study describes a sector/landscape, not a company on sale —
    // it must not mint a deal target even if the Smart File names a company. (MB-300)
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'market_study',
      prospectus_summary: { company_name: 'Acme Market' },
    } as never);
    vi.mocked(companyService.findByNameFuzzy).mockResolvedValue(null as never);

    await service.processUpload(
      'uploads/market-study.pdf',
      'market-study.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
    );

    expect(companyService.findByNameFuzzy).not.toHaveBeenCalled();
    expect(companyService.createFromDTO).not.toHaveBeenCalled();
  });

  it('does not auto-create a company from a financial_statement email attachment', async () => {
    // A standalone financial statement (e.g. a buyer's AFS shared for
    // financing) describes finances, not a company on sale. (MB-300)
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'financial_statement',
      prospectus_summary: { company_name: 'Frontier Resources Pte. Ltd.' },
    } as never);
    vi.mocked(companyService.findByNameFuzzy).mockResolvedValue(null as never);

    await service.processUpload(
      'uploads/frontier-afs.pdf',
      'financial_statement_FRPL_AFS_FY24.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
    );

    expect(companyService.findByNameFuzzy).not.toHaveBeenCalled();
    expect(companyService.createFromDTO).not.toHaveBeenCalled();
  });

  it('does not auto-create a company from a legal_document email attachment', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'legal_document',
      prospectus_summary: { company_name: 'Project Gemini' },
    } as never);
    vi.mocked(companyService.findByNameFuzzy).mockResolvedValue(null as never);

    await service.processUpload(
      'uploads/spa.docx',
      'Project_Gemini_Stock_Purchase_Agreement.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      undefined,
      undefined,
      true,
    );

    expect(companyService.findByNameFuzzy).not.toHaveBeenCalled();
    expect(companyService.createFromDTO).not.toHaveBeenCalled();
  });

  it('upserts company_financials for a financial_statement email attachment matched to an existing company', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'financial_statement',
      matched_companies: [{ id: 'company-1', name: 'Project Lisbon', type: 'company', similarity: 1 }],
      financial_statement_summary: {
        company_name: 'Lisbon Holdings Pte. Ltd.',
        financials: [
          { fiscal_year: 2024, revenue_usd_mn: 120, ebitda_usd_mn: 30, ev_usd_mn: null, ebitda_margin: 0.25, ev_ebitda: null, revenue_cagr_vs_prior: null },
          { fiscal_year: 2023, revenue_usd_mn: 100, ebitda_usd_mn: 22, ev_usd_mn: null, ebitda_margin: 0.22, ev_ebitda: null, revenue_cagr_vs_prior: null },
        ],
      },
    } as never);

    await service.processUpload(
      'uploads/lisbon_afs.pdf',
      'financial_statement_Pr._Lisbon_Financial_Overview.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
    );

    expect(companyFinancialRepo.bulkUpsertForCompany).toHaveBeenCalledWith(
      'company-1',
      expect.arrayContaining([
        expect.objectContaining({ fiscal_year: 2024, revenue_usd_mn: 120, ebitda_usd_mn: 30 }),
        expect.objectContaining({ fiscal_year: 2023, revenue_usd_mn: 100, ebitda_usd_mn: 22 }),
      ]),
    );
    expect(companyService.createFromDTO).not.toHaveBeenCalled();
  });

  it('does not create a company when a financial_statement email attachment has no matched company', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'financial_statement',
      matched_companies: [],
      financial_statement_summary: {
        company_name: 'Frontier Resources Pte. Ltd.',
        financials: [
          { fiscal_year: 2024, revenue_usd_mn: 500, ebitda_usd_mn: 80, ev_usd_mn: null, ebitda_margin: 0.16, ev_ebitda: null, revenue_cagr_vs_prior: null },
        ],
      },
    } as never);
    vi.mocked(companyService.findByNameFuzzy).mockResolvedValue(null as never);

    await service.processUpload(
      'uploads/frontier_afs.pdf',
      'financial_statement_FRPL_AFS_FY24.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
    );

    expect(companyFinancialRepo.bulkUpsertForCompany).not.toHaveBeenCalled();
    expect(companyService.createFromDTO).not.toHaveBeenCalled();
  });

  it('skips financials upsert for financial_statement uploaded without origin_email', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'financial_statement',
      matched_companies: [{ id: 'company-1', name: 'Project Lisbon', type: 'company', similarity: 1 }],
      financial_statement_summary: {
        company_name: 'Lisbon Holdings Pte. Ltd.',
        financials: [{ fiscal_year: 2024, revenue_usd_mn: 120, ebitda_usd_mn: 30, ev_usd_mn: null, ebitda_margin: 0.25, ev_ebitda: null, revenue_cagr_vs_prior: null }],
      },
    } as never);

    // origin_email defaults to false
    await service.processUpload('uploads/lisbon_afs.pdf', 'lisbon_afs.pdf', 'application/pdf');

    expect(companyFinancialRepo.bulkUpsertForCompany).not.toHaveBeenCalled();
  });

  it('skips entries whose extracted names are blank', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
      prospectus_summary: {
        company_name: '   ',
        project_name: '',
        segment: 'Industrial Tech',
      },
    } as never);

    await service.processUpload(
      'uploads/teaser.pdf',
      'teaser.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
    );

    expect(companyService.findByNameFuzzy).not.toHaveBeenCalled();
    expect(companyService.createFromDTO).not.toHaveBeenCalled();
    expect(companyService.updateFromDTO).not.toHaveBeenCalled();
  });

  it('does not write a generic company_name to target when auto-creating', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
      prospectus_summary: {
        company_name: 'Company Overview',
        project_name: 'Project Atlas',
        segment: 'Fintech',
      },
    } as never);
    vi.mocked(companyService.findByNameFuzzy).mockResolvedValue(null as never);
    vi.mocked(companyService.createFromDTO).mockResolvedValue({
      id: 'company-new',
      project_name: 'Project Atlas',
    } as never);

    await service.processUpload(
      'uploads/teaser.pdf',
      'teaser.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
    );

    // Identity falls back to the project codename; the generic phrase never
    // reaches `target`.
    expect(companyService.findByNameFuzzy).toHaveBeenCalledWith('Project Atlas');
    const created = vi.mocked(companyService.createFromDTO).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(created.target).toBeUndefined();
    expect(created.project_name).toBe('Project Atlas');
    expect(created.segment).toBe('Fintech');
  });

  it('does not create a company when email-origin attachment has only a generic phrase as project_name', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
      prospectus_summary: { project_name: 'Company Overview' },
    } as never);

    await service.processUpload(
      'uploads/teaser.pdf',
      'teaser.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
    );

    expect(companyService.findByNameFuzzy).not.toHaveBeenCalled();
    expect(companyService.createFromDTO).not.toHaveBeenCalled();
  });

  it('does not create a blank company when an email-origin attachment has no company identity', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
      prospectus_summary: {
        segment: 'Industrial Tech',
      },
    } as never);

    await service.processUpload(
      'uploads/teaser.pdf',
      'teaser.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
    );

    expect(companyService.findByNameFuzzy).not.toHaveBeenCalled();
    expect(companyService.createFromDTO).not.toHaveBeenCalled();
    expect(companyService.updateFromDTO).not.toHaveBeenCalled();
  });

  it('takes a scoped advisory lock while resolving named email-origin companies', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const transaction = vi.fn(async (cb: (tx: { execute: typeof execute }) => Promise<unknown>) =>
      cb({ execute }),
    );
    service = new FileService(
      { transaction } as unknown as DbClient,
      'workspace-1',
      fileRepo,
      companyAnalysisService,
      aiScreeningService,
      criteriaRepo,
      screeningRepo,
      companyFinancialRepo,
      companyService,
      makeCompanyFxAdjustmentRepoStub(),
      makeUserWorkspaceRepoStub(),
    );
    (service as unknown as { buildCompanyService: () => CompanyService }).buildCompanyService =
      () => companyService;
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
      prospectus_summary: { company_name: 'Acme Corp' },
    } as never);

    await service.processUpload(
      'uploads/teaser.pdf',
      'teaser.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
    );

    expect(transaction).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
    expect(companyService.createFromDTO).toHaveBeenCalledOnce();
  });
});

describe('FileService.approve', () => {
  let fileRepo: FileRepository;
  let companyService: CompanyService;
  let companyFinancialRepo: CompanyFinancialRepository;
  let companyFxAdjustmentRepo: CompanyFxAdjustmentRepository;
  let companyAnalysisService: CompanyAnalysisService;
  let criteriaRepo: CriteriaRepository;
  let screeningRepo: ScreeningRepository;
  let aiScreeningService: AIScreeningService;
  let service: FileService;

  const prospectusNotes = JSON.stringify({
    file_type: 'prospectus',
    prospectus_summary: {
      company_name: 'Acme Corp',
      project_name: 'Project Owl',
      segment: 'Fintech',
      geography: 'Indonesia',
      ownership: 'Founder-led',
      financials: [{ fiscal_year: 2023, revenue_usd_mn: 100, ebitda_usd_mn: 20, ev_usd_mn: null, ebitda_margin: 0.2, ev_ebitda: null, revenue_cagr_vs_prior: null }],
      fx_adjustments: [],
    },
  });

  beforeEach(() => {
    fileRepo = makeFileRepoStub();
    companyService = makeCompanyServiceStub();
    companyFinancialRepo = makeCompanyFinancialRepoStub();
    companyFxAdjustmentRepo = makeCompanyFxAdjustmentRepoStub();
    companyAnalysisService = makeCompanyAnalysisServiceStub();
    criteriaRepo = makeCriteriaRepoStub();
    screeningRepo = makeScreeningRepoStub();
    aiScreeningService = makeAIScreeningServiceStub();
    service = new FileService(
      makeMockDb(),
      'workspace-1',
      fileRepo,
      companyAnalysisService,
      aiScreeningService,
      criteriaRepo,
      screeningRepo,
      companyFinancialRepo,
      companyService,
      companyFxAdjustmentRepo,
      makeUserWorkspaceRepoStub(),
    );
    vi.mocked(criteriaRepo.findAll).mockResolvedValue([]);
    vi.mocked(companyAnalysisService.dispatch).mockResolvedValue({ runId: 'run-1' });
  });

  it('creates a new company from AI data when create_company_from_ai is true', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', structured_notes: prospectusNotes }),
    );
    vi.mocked(companyService.createFromDTO).mockResolvedValue({ id: 'company-new' } as never);
    vi.mocked(companyService.findById).mockResolvedValue(makeCompany({ id: 'company-new' }));

    const input: ApproveFileInput = {
      file_type: 'prospectus',
      matched_company_id: null,
      create_company_from_ai: true,
      entered_by: 'user-uuid',
      deal_type: 'majority',
      banker: 'Goldman Sachs',
    };
    await service.approve('file-1', input);

    expect(companyService.createFromDTO).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'Acme Corp', source: 'inbound', pipeline_stage: 'L0' }),
      'created_from_file:file-1',
    );
  });

  it('throws CompanyPipelineRequirementsError when required fields are missing', async () => {
    const { CompanyPipelineRequirementsError } = await import('./companyService');
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', structured_notes: prospectusNotes }),
    );
    const input: ApproveFileInput = {
      file_type: 'prospectus',
      matched_company_id: null,
      create_company_from_ai: true,
      // entered_by, deal_type, banker all absent
    };
    await expect(service.approve('file-1', input)).rejects.toBeInstanceOf(CompanyPipelineRequirementsError);
    expect(companyService.createFromDTO).not.toHaveBeenCalled();
  });

  it("creates the company when the workspace's Required Fields no longer include the missing ones", async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', structured_notes: prospectusNotes }),
    );
    vi.mocked(companyService.createFromDTO).mockResolvedValue({ id: 'company-new' } as never);
    vi.mocked(companyService.findById).mockResolvedValue(makeCompany({ id: 'company-new' }));
    vi.mocked(companyService.missingPipelineFields).mockResolvedValueOnce([]);

    const input: ApproveFileInput = {
      file_type: 'prospectus',
      matched_company_id: null,
      create_company_from_ai: true,
      // entered_by, deal_type, banker all absent — not required here
    };
    await service.approve('file-1', input);

    expect(companyService.missingPipelineFields).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'Acme Corp', source: 'inbound' }),
    );
    expect(companyService.createFromDTO).toHaveBeenCalled();
  });

  it('prefers user-supplied source, geography and segment over the AI values', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', structured_notes: prospectusNotes }),
    );
    vi.mocked(companyService.createFromDTO).mockResolvedValue({ id: 'company-new' } as never);
    vi.mocked(companyService.findById).mockResolvedValue(makeCompany({ id: 'company-new' }));

    const input: ApproveFileInput = {
      file_type: 'prospectus',
      matched_company_id: null,
      create_company_from_ai: true,
      entered_by: 'user-uuid',
      deal_type: 'majority',
      source: 'outbound',
      geography: 'Vietnam',
      segment: 'Logistics',
      // No banker — allowed because source is outbound.
    };
    await service.approve('file-1', input);

    expect(companyService.createFromDTO).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'outbound',
        geography: 'Vietnam',
        segment: 'Logistics',
      }),
      'created_from_file:file-1',
    );
  });

  it('accepts reviewer-supplied geography/segment when the AI extracted neither', async () => {
    const notesWithoutGeoOrSegment = JSON.stringify({
      file_type: 'prospectus',
      prospectus_summary: {
        company_name: 'Acme Corp',
        project_name: 'Project Owl',
        financials: [],
        fx_adjustments: [],
      },
    });
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', structured_notes: notesWithoutGeoOrSegment }),
    );
    vi.mocked(companyService.createFromDTO).mockResolvedValue({ id: 'company-new' } as never);
    vi.mocked(companyService.findById).mockResolvedValue(makeCompany({ id: 'company-new' }));

    const input: ApproveFileInput = {
      file_type: 'prospectus',
      matched_company_id: null,
      create_company_from_ai: true,
      entered_by: 'user-uuid',
      deal_type: 'majority',
      banker: 'Goldman Sachs',
      geography: 'Malaysia',
      segment: 'Healthcare',
    };
    await service.approve('file-1', input);

    expect(companyService.createFromDTO).toHaveBeenCalledWith(
      expect.objectContaining({ geography: 'Malaysia', segment: 'Healthcare' }),
      'created_from_file:file-1',
    );
  });

  it('creates at L0 with matched_track_ids from structured_notes', async () => {
    const notesWithTracks = JSON.stringify({
      file_type: 'prospectus',
      suggested_track_ids: ['track-abc', 'track-def'],
      prospectus_summary: {
        company_name: 'Acme Corp',
        project_name: 'Project Owl',
        segment: 'Fintech',
        geography: 'Indonesia',
        financials: [],
        fx_adjustments: [],
      },
    });
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', structured_notes: notesWithTracks }),
    );
    vi.mocked(companyService.createFromDTO).mockResolvedValue({ id: 'company-new' } as never);
    vi.mocked(companyService.findById).mockResolvedValue(makeCompany({ id: 'company-new' }));

    const input: ApproveFileInput = {
      file_type: 'prospectus',
      matched_company_id: null,
      create_company_from_ai: true,
      entered_by: 'user-uuid',
      deal_type: 'majority',
      banker: 'Goldman Sachs',
    };
    await service.approve('file-1', input);

    expect(companyService.createFromDTO).toHaveBeenCalledWith(
      expect.objectContaining({
        pipeline_stage: 'L0',
        matched_track_ids: ['track-abc', 'track-def'],
      }),
      'created_from_file:file-1',
    );
  });

  it('uses empty matched_track_ids when suggested_track_ids is absent or invalid', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', structured_notes: prospectusNotes }),
    );
    vi.mocked(companyService.createFromDTO).mockResolvedValue({ id: 'company-new' } as never);
    vi.mocked(companyService.findById).mockResolvedValue(makeCompany({ id: 'company-new' }));

    await service.approve('file-1', {
      file_type: 'prospectus',
      matched_company_id: null,
      create_company_from_ai: true,
      entered_by: 'user-uuid',
      deal_type: 'majority',
      banker: 'Goldman Sachs',
    });

    expect(companyService.createFromDTO).toHaveBeenCalledWith(
      expect.objectContaining({ matched_track_ids: [] }),
      expect.any(String),
    );
  });


  it('applies company_field_updates for matched existing company', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', structured_notes: prospectusNotes }),
    );
    vi.mocked(companyService.findById).mockResolvedValue(makeCompany());

    const input: ApproveFileInput = {
      file_type: 'prospectus',
      matched_company_id: 'company-1',
      company_field_updates: { project_name: 'Project Owl', segment: 'Fintech' },
    };
    await service.approve('file-1', input);

    expect(companyService.updateFromDTO).toHaveBeenCalledWith(
      'company-1',
      { project_name: 'Project Owl', segment: 'Fintech' },
      'enriched_from_file:file-1',
    );
  });

  it('allows approving an email-origin file to a matched outbound company', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({
        id: 'file-1',
        origin_email: true,
        structured_notes: prospectusNotes,
      }),
    );
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ id: 'company-outbound', source: 'outbound' }),
    );

    const input: ApproveFileInput = {
      file_type: 'prospectus',
      matched_company_id: 'company-outbound',
      company_field_updates: { segment: 'Fintech' },
    };

    await service.approve('file-1', input);

    expect(companyService.updateFromDTO).toHaveBeenCalledWith(
      'company-outbound',
      { segment: 'Fintech' },
      'enriched_from_file:file-1',
    );
    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({ processing_status: 'completed' }),
    );
  });

  it('does not call updateFromDTO when company_field_updates is empty', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', structured_notes: prospectusNotes }),
    );
    vi.mocked(companyService.findById).mockResolvedValue(makeCompany());

    const input: ApproveFileInput = {
      file_type: 'prospectus',
      matched_company_id: 'company-1',
    };
    await service.approve('file-1', input);

    expect(companyService.updateFromDTO).not.toHaveBeenCalled();
  });

  it('upserts financials only for years the user ticked', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', structured_notes: prospectusNotes }),
    );
    vi.mocked(companyService.findById).mockResolvedValue(makeCompany());

    const input: ApproveFileInput = {
      file_type: 'prospectus',
      matched_company_id: 'company-1',
      financial_years_to_apply: [2023],
    };
    await service.approve('file-1', input);

    expect(companyFinancialRepo.bulkUpsertForCompany).toHaveBeenCalledWith(
      'company-1',
      expect.arrayContaining([expect.objectContaining({ fiscal_year: 2023 })]),
    );
  });

  it('does not upsert financials when financial_years_to_apply is empty', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', structured_notes: prospectusNotes }),
    );
    vi.mocked(companyService.findById).mockResolvedValue(makeCompany());

    const input: ApproveFileInput = { file_type: 'prospectus', matched_company_id: 'company-1' };
    await service.approve('file-1', input);

    expect(companyFinancialRepo.bulkUpsertForCompany).not.toHaveBeenCalled();
  });

  it('applies the matched company\'s own entry from a multi-company file', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({
        id: 'file-1',
        structured_notes: JSON.stringify({
          file_type: 'shopping_list',
          companies: [
            {
              company_name: 'Acme Corp',
              financials: [{ fiscal_year: 2023, revenue_usd_mn: 100, ebitda_usd_mn: null, ev_usd_mn: null, ebitda_margin: null, ev_ebitda: null, revenue_cagr_vs_prior: null }],
            },
            {
              company_name: 'Beta Ltd',
              financials: [{ fiscal_year: 2023, revenue_usd_mn: 55, ebitda_usd_mn: null, ev_usd_mn: null, ebitda_margin: null, ev_ebitda: null, revenue_cagr_vs_prior: null }],
            },
          ],
        }),
      }),
    );
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ id: 'company-beta', target: 'Beta Ltd' }),
    );

    const input: ApproveFileInput = {
      file_type: 'shopping_list',
      matched_company_id: 'company-beta',
      financial_years_to_apply: [2023],
    };
    await service.approve('file-1', input);

    // Beta's financials are applied — not the first entry's (Acme).
    expect(companyFinancialRepo.bulkUpsertForCompany).toHaveBeenCalledWith(
      'company-beta',
      [expect.objectContaining({ fiscal_year: 2023, revenue_usd_mn: 55 })],
    );
  });

  it('marks file as completed and dispatches downstream jobs', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', structured_notes: prospectusNotes }),
    );
    vi.mocked(companyService.findById).mockResolvedValue(makeCompany());

    const input: ApproveFileInput = { file_type: 'prospectus', matched_company_id: 'company-1' };
    await service.approve('file-1', input);

    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({ processing_status: 'completed' }),
    );
    expect(companyAnalysisService.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1' }),
    );
  });

  it('does not dispatch jobs when no company is resolved', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(makeFile({ id: 'file-1' }));

    const input: ApproveFileInput = { file_type: 'mom', matched_company_id: null };
    await service.approve('file-1', input);

    expect(companyAnalysisService.dispatch).not.toHaveBeenCalled();
  });

  it('skips create_company_from_ai when company_name is a generic document phrase', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({
        id: 'file-1',
        structured_notes: JSON.stringify({
          file_type: 'prospectus',
          prospectus_summary: {
            company_name: 'Company Overview',
            project_name: null,
          },
        }),
      }),
    );

    const input: ApproveFileInput = {
      file_type: 'prospectus',
      matched_company_id: null,
      create_company_from_ai: true,
    };
    await service.approve('file-1', input);

    expect(companyService.createFromDTO).not.toHaveBeenCalled();
    expect(companyAnalysisService.dispatch).not.toHaveBeenCalled();
  });

  it('skips create_company_from_ai when project_name is a generic document phrase', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({
        id: 'file-1',
        structured_notes: JSON.stringify({
          file_type: 'prospectus',
          prospectus_summary: {
            company_name: null,
            project_name: 'Executive Summary',
          },
        }),
      }),
    );

    const input: ApproveFileInput = {
      file_type: 'prospectus',
      matched_company_id: null,
      create_company_from_ai: true,
    };
    await service.approve('file-1', input);

    expect(companyService.createFromDTO).not.toHaveBeenCalled();
  });

  it('queues an AI Workforce screening task for the approved company', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', structured_notes: prospectusNotes }),
    );
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ matched_track_ids: ['track-1'] }),
    );

    const input: ApproveFileInput = { file_type: 'prospectus', matched_company_id: 'company-1' };
    await service.approve('file-1', input);

    await vi.waitFor(() => {
      expect(aiScreeningService.enqueue).toHaveBeenCalledWith(['company-1'], {
        mode: 'tracks',
        force: true,
      });
    });
    // Screening rows are the task's job now, not the file's.
    expect(screeningRepo.insert).not.toHaveBeenCalled();
  });

  it('does not fail the approval when queuing screening fails', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', structured_notes: prospectusNotes }),
    );
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ matched_track_ids: ['track-1'] }),
    );
    vi.mocked(aiScreeningService.enqueue).mockRejectedValue(new Error('queue down'));

    const input: ApproveFileInput = { file_type: 'prospectus', matched_company_id: 'company-1' };
    await expect(service.approve('file-1', input)).resolves.toBeDefined();
    await vi.waitFor(() => expect(aiScreeningService.enqueue).toHaveBeenCalled());
  });

  describe('FileService.approve (fund_updates v1 proposals)', () => {
    let mockApplyService: any;

    beforeEach(() => {
      mockApplyService = {
        applySelected: vi.fn().mockResolvedValue({
          applied: 1,
          created_assets: 1,
          updated_assets: 0,
          skipped: 0,
          txns_inserted: 1,
          valuations_upserted: 0,
        }),
        buildReview: vi.fn().mockResolvedValue([]),
      };
      service.setFundUpdateApplyService(mockApplyService);
    });

    it('rejects v1 proposal missing row_accounting', async () => {
      const v1Notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'workbook_fallback_v1',
        fund_update_proposal: {
          schema_version: 'workbook_fallback_v1',
          entities: [{ proposalId: 'ent_1', entityType: 'portfolio_company', originalName: 'Acme Corp' }],
          events: [{ eventType: 'asset_investment', relatedFundRef: 'Fund I', normalizedCurrency: 'USD', normalizedAmount: 100 }],
          valuations: [],
          assets: [{ code: 'ACME', name: 'Acme Corp', fund: 'Fund I', txns: [{ currency: 'USD' }] }],
          // missing row_accounting
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({ id: 'file-1', file_type: 'fund_updates', structured_notes: v1Notes }),
      );

      await expect(
        service.approve('file-1', { file_type: 'fund_updates', matched_company_id: null, fund_update_asset_codes: ['ACME'] }),
      ).rejects.toThrow('missing row_accounting or plannedRows');
    });

    it('rejects v1 proposal missing plannedRows in row_accounting', async () => {
      const v1Notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'workbook_fallback_v1',
        fund_update_proposal: {
          schema_version: 'workbook_fallback_v1',
          entities: [{ proposalId: 'ent_1', entityType: 'portfolio_company', originalName: 'Acme Corp' }],
          events: [{ eventType: 'asset_investment', relatedFundRef: 'Fund I', normalizedCurrency: 'USD', normalizedAmount: 100 }],
          valuations: [],
          row_accounting: {
            totalDataRows: 1,
            parsedRows: [2],
            excludedRows: [],
            ambiguousRows: [],
            coveragePct: 100,
            unaccountedRows: [],
            // missing plannedRows
          },
          assets: [{ code: 'ACME', name: 'Acme Corp', fund: 'Fund I', txns: [{ currency: 'USD' }] }],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({ id: 'file-1', file_type: 'fund_updates', structured_notes: v1Notes }),
      );

      await expect(
        service.approve('file-1', { file_type: 'fund_updates', matched_company_id: null, fund_update_asset_codes: ['ACME'] }),
      ).rejects.toThrow('missing row_accounting or plannedRows');
    });

    it('rejects v1 proposal when accounting has tampered overlapping categories', async () => {
      const v1Notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'workbook_fallback_v1',
        fund_update_proposal: {
          schema_version: 'workbook_fallback_v1',
          stats: { total_data_rows: 1 },
          interpretation: { currencies: [{ sourceCurrency: 'USD', sourceUnit: '1', multiplier: 1 }] },
          entities: [{ proposalId: 'ent_1', entityType: 'portfolio_company', originalName: 'Acme Corp' }],
          events: [{
            eventType: 'asset_investment',
            sourceAction: '投资',
            relatedFundRef: 'Fund I',
            sourceCurrency: 'USD',
            normalizedCurrency: 'USD',
            sourceUnit: 'USD',
            amountMultiplier: 1,
            sourceAmount: 100,
            normalizedAmount: 100,
            sourceLocation: { sheet: 'Sheet1', row: 2 },
          }],
          valuations: [],
          row_accounting: {
            totalDataRows: 1,
            plannedRows: [{ sheet: 'Sheet1', row: 2, rowKey: 'Sheet1::::2' }],
            parsedRows: [2],
            parsedRowItems: [{ sheet: 'Sheet1', row: 2, rowKey: 'Sheet1::::2' }],
            excludedRows: [{ sheet: 'Sheet1', row: 2, reason: 'Duplicate!' }], // Overlapping!
            ambiguousRows: [],
            coveragePct: 100,
            unaccountedRows: [],
          },
          assets: [{ code: 'ACME', name: 'Acme Corp', fund: 'Fund I', txns: [{ currency: 'USD' }] }],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({ id: 'file-1', file_type: 'fund_updates', structured_notes: v1Notes }),
      );

      await expect(
        service.approve('file-1', { file_type: 'fund_updates', matched_company_id: null, fund_update_asset_codes: ['ACME'] }),
      ).rejects.toThrow('Categories must be strictly mutually disjoint');
    });

    it('rejects v1 proposal when deterministic validation has hard failures (e.g. unresolved currency)', async () => {
      const v1Notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'workbook_fallback_v1',
        fund_update_proposal: {
          schema_version: 'workbook_fallback_v1',
          stats: { total_data_rows: 1 },
          interpretation: { currencies: [] },
          entities: [{ proposalId: 'ent_1', entityType: 'portfolio_company', originalName: 'Acme Corp' }],
          events: [{
            eventType: 'asset_investment',
            sourceAction: '投资',
            relatedFundRef: 'Fund I',
            sourceCurrency: null,
            normalizedCurrency: null, // Unresolved currency!
            sourceAmount: 100,
            normalizedAmount: null,
            sourceLocation: { sheet: 'Sheet1', row: 2 },
          }],
          valuations: [],
          row_accounting: {
            totalDataRows: 1,
            plannedRows: [{ sheet: 'Sheet1', row: 2, rowKey: 'Sheet1::::2' }],
            parsedRows: [2],
            parsedRowItems: [{ sheet: 'Sheet1', row: 2, rowKey: 'Sheet1::::2' }],
            excludedRows: [],
            ambiguousRows: [],
            coveragePct: 100,
            unaccountedRows: [],
          },
          assets: [{ code: 'ACME', name: 'Acme Corp', fund: 'Fund I', txns: [{ currency: 'USD' }] }],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({ id: 'file-1', file_type: 'fund_updates', structured_notes: v1Notes }),
      );

      await expect(
        service.approve('file-1', { file_type: 'fund_updates', matched_company_id: null, fund_update_asset_codes: ['ACME'] }),
      ).rejects.toThrow('Cannot approve proposal with critical validation failures');
    });

    it('rejects v1 proposal containing only investor-to-fund events without portfolio assets', async () => {
      const v1Notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'workbook_fallback_v1',
        fund_update_proposal: {
          schema_version: 'workbook_fallback_v1',
          stats: { total_data_rows: 1 },
          interpretation: { currencies: [{ sourceCurrency: 'USD', sourceUnit: '1', multiplier: 1 }] },
          entities: [{ proposalId: 'ent_1', entityType: 'investor', originalName: 'LP Investor' }],
          events: [{
            eventType: 'capital_contribution', // Investor event only!
            sourceAction: '实缴',
            relatedFundRef: 'Fund I',
            sourceCurrency: 'USD',
            normalizedCurrency: 'USD',
            sourceUnit: 'USD',
            amountMultiplier: 1,
            sourceAmount: 100,
            normalizedAmount: 100,
            sourceLocation: { sheet: 'Sheet1', row: 2 },
          }],
          valuations: [],
          row_accounting: {
            totalDataRows: 1,
            plannedRows: [{ sheet: 'Sheet1', row: 2, rowKey: 'Sheet1::::2' }],
            parsedRows: [2],
            parsedRowItems: [{ sheet: 'Sheet1', row: 2, rowKey: 'Sheet1::::2' }],
            excludedRows: [],
            ambiguousRows: [],
            coveragePct: 100,
            unaccountedRows: [],
          },
          assets: [], // No portfolio assets
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({ id: 'file-1', file_type: 'fund_updates', structured_notes: v1Notes }),
      );

      await expect(
        service.approve('file-1', { file_type: 'fund_updates', matched_company_id: null, fund_update_asset_codes: [] }),
      ).rejects.toThrow('contains only investor-to-fund events and no persistable portfolio assets');
    });

    it('rejects v1 proposal with duplicate planned row keys in row_accounting', async () => {
      const v1Notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'workbook_fallback_v1',
        fund_update_proposal: {
          schema_version: 'workbook_fallback_v1',
          stats: { total_data_rows: 2 },
          interpretation: { currencies: [{ sourceCurrency: 'USD', sourceUnit: '1', multiplier: 1 }] },
          entities: [{ proposalId: 'ent_1', entityType: 'portfolio_company', originalName: 'Acme Corp' }],
          events: [{
            eventType: 'asset_investment',
            sourceAction: '投资',
            relatedFundRef: 'Fund I',
            sourceCurrency: 'USD',
            normalizedCurrency: 'USD',
            sourceUnit: 'USD',
            amountMultiplier: 1,
            sourceAmount: 100,
            normalizedAmount: 100,
            sourceLocation: { sheet: 'Sheet1', row: 2 },
          }],
          valuations: [],
          row_accounting: {
            totalDataRows: 2,
            plannedRows: [
              { sheet: 'Sheet1', row: 2, rowKey: 'Sheet1::::2' },
              { sheet: 'Sheet1', row: 2, rowKey: 'Sheet1::::2' }, // Duplicate!
            ],
            parsedRows: [2],
            parsedRowItems: [{ sheet: 'Sheet1', row: 2, rowKey: 'Sheet1::::2' }],
            excludedRows: [],
            ambiguousRows: [],
            coveragePct: 100,
            unaccountedRows: [],
          },
          assets: [{ code: 'ACME', name: 'Acme Corp', fund: 'Fund I', txns: [{ currency: 'USD' }] }],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({ id: 'file-1', file_type: 'fund_updates', structured_notes: v1Notes }),
      );

      await expect(
        service.approve('file-1', { file_type: 'fund_updates', matched_company_id: null, fund_update_asset_codes: ['ACME'] }),
      ).rejects.toThrow('duplicate planned row keys detected');
    });

    it('rejects v1 proposal with shrunk plannedRows / stat mismatch', async () => {
      const v1Notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'workbook_fallback_v1',
        fund_update_proposal: {
          schema_version: 'workbook_fallback_v1',
          stats: { total_data_rows: 10 }, // Stats says 10
          interpretation: { currencies: [{ sourceCurrency: 'USD', sourceUnit: '1', multiplier: 1 }] },
          entities: [{ proposalId: 'ent_1', entityType: 'portfolio_company', originalName: 'Acme Corp' }],
          events: [{
            eventType: 'asset_investment',
            sourceAction: '投资',
            relatedFundRef: 'Fund I',
            sourceCurrency: 'USD',
            normalizedCurrency: 'USD',
            sourceUnit: 'USD',
            amountMultiplier: 1,
            sourceAmount: 100,
            normalizedAmount: 100,
            sourceLocation: { sheet: 'Sheet1', row: 2 },
          }],
          valuations: [],
          row_accounting: {
            totalDataRows: 10, // Accounting says 10, but plannedRows only has 1
            plannedRows: [{ sheet: 'Sheet1', row: 2, rowKey: 'Sheet1::::2' }],
            parsedRows: [2],
            parsedRowItems: [{ sheet: 'Sheet1', row: 2, rowKey: 'Sheet1::::2' }],
            excludedRows: [],
            ambiguousRows: [],
            coveragePct: 100,
            unaccountedRows: [],
          },
          assets: [{ code: 'ACME', name: 'Acme Corp', fund: 'Fund I', txns: [{ currency: 'USD' }] }],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({ id: 'file-1', file_type: 'fund_updates', structured_notes: v1Notes }),
      );

      await expect(
        service.approve('file-1', { file_type: 'fund_updates', matched_company_id: null, fund_update_asset_codes: ['ACME'] }),
      ).rejects.toThrow('must equal unique plannedRows universe size');
    });

    it('rejects v1 proposal with tampered normalizedAmount', async () => {
      const v1Notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'workbook_fallback_v1',
        fund_update_proposal: {
          schema_version: 'workbook_fallback_v1',
          stats: { total_data_rows: 1 },
          interpretation: { currencies: [{ sourceCurrency: 'USD', sourceUnit: '1', multiplier: 1 }] },
          entities: [{ proposalId: 'ent_1', entityType: 'portfolio_company', originalName: 'Acme Corp' }],
          events: [{
            eventType: 'asset_investment',
            sourceAction: '投资',
            relatedFundRef: 'Fund I',
            sourceCurrency: 'USD',
            normalizedCurrency: 'USD',
            sourceUnit: 'USD',
            amountMultiplier: 1,
            sourceAmount: 100,
            normalizedAmount: 999999, // Tampered! Recomputed is 100
            sourceLocation: { sheet: 'Sheet1', row: 2 },
          }],
          valuations: [],
          row_accounting: {
            totalDataRows: 1,
            plannedRows: [{ sheet: 'Sheet1', row: 2, rowKey: 'Sheet1::::2' }],
            parsedRows: [2],
            parsedRowItems: [{ sheet: 'Sheet1', row: 2, rowKey: 'Sheet1::::2' }],
            excludedRows: [],
            ambiguousRows: [],
            coveragePct: 100,
            unaccountedRows: [],
          },
          assets: [{ code: 'ACME', name: 'Acme Corp', fund: 'Fund I', txns: [{ currency: 'USD' }] }],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({ id: 'file-1', file_type: 'fund_updates', structured_notes: v1Notes }),
      );

      await expect(
        service.approve('file-1', { file_type: 'fund_updates', matched_company_id: null, fund_update_asset_codes: ['ACME'] }),
      ).rejects.toThrow('stored normalizedAmount (999999) does not match recomputed amount (100)');
    });

    it('successfully approves valid v1 fund update proposal and marks file completed', async () => {
      const v1Notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'workbook_fallback_v1',
        fund_update_proposal: {
          schema_version: 'workbook_fallback_v1',
          stats: { total_data_rows: 1 },
          interpretation: { currencies: [{ sourceCurrency: 'USD', sourceUnit: '1', multiplier: 1 }] },
          entities: [{ proposalId: 'ent_1', entityType: 'portfolio_company', originalName: 'Acme Corp' }],
          events: [{
            eventType: 'asset_investment',
            sourceAction: '投资',
            relatedFundRef: 'Fund I',
            sourceCurrency: 'USD',
            normalizedCurrency: 'USD',
            sourceUnit: 'USD',
            amountMultiplier: 1,
            sourceAmount: 100,
            normalizedAmount: 100,
            sourceLocation: { sheet: 'Sheet1', row: 2 },
          }],
          valuations: [],
          row_accounting: {
            totalDataRows: 1,
            plannedRows: [{ sheet: 'Sheet1', row: 2, rowKey: 'Sheet1::::2' }],
            parsedRows: [2],
            parsedRowItems: [{ sheet: 'Sheet1', row: 2, rowKey: 'Sheet1::::2' }],
            excludedRows: [],
            ambiguousRows: [],
            coveragePct: 100,
            unaccountedRows: [],
          },
          assets: [{ code: 'ACME', name: 'Acme Corp', fund: 'Fund I', txns: [{ currency: 'USD' }] }],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({ id: 'file-1', file_type: 'fund_updates', structured_notes: v1Notes }),
      );

      const result = await service.approve('file-1', {
        file_type: 'fund_updates',
        matched_company_id: null,
        fund_update_asset_codes: ['ACME'],
      });

      expect(mockApplyService.applySelected).toHaveBeenCalledWith(
        expect.any(Array),
        ['ACME'],
        undefined,
        { isV1: true, fileId: 'file-1', fundCatalogItems: undefined, executor: expect.anything() },
        undefined,
      );
      expect(fileRepo.updatePartial).toHaveBeenCalledWith(
        'file-1',
        expect.objectContaining({ processing_status: 'completed' }),
        expect.anything(),
      );
      expect(result.fund_update).toBeDefined();
    });

    it('threads fund_update_catalog_selections to applySelected', async () => {
      const fileRepo = makeFileRepoStub();
      const mockApplyService = {
        applySelected: vi.fn().mockResolvedValue({
          applied: 1,
          created_assets: 1,
          updated_assets: 0,
          skipped: 0,
          txns_inserted: 1,
          valuations_upserted: 0,
        }),
      };

      const service = makeService({ fileRepo });
      service.setFundUpdateApplyService(mockApplyService as any);

      const v1Notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'workbook_fallback_v1',
        fund_update_proposal: {
          schema_version: 'workbook_fallback_v1',
          stats: { total_data_rows: 1 },
          interpretation: { currencies: [{ sourceCurrency: 'USD', sourceUnit: '1', multiplier: 1 }] },
          entities: [{ proposalId: 'ent_1', entityType: 'portfolio_company', originalName: 'Acme Corp' }],
          events: [{
            eventType: 'asset_investment',
            sourceAction: '投资',
            relatedFundRef: 'Fund I',
            sourceCurrency: 'USD',
            normalizedCurrency: 'USD',
            sourceUnit: 'USD',
            amountMultiplier: 1,
            sourceAmount: 100,
            normalizedAmount: 100,
            sourceLocation: { sheet: 'Sheet1', row: 2 },
          }],
          valuations: [],
          row_accounting: {
            totalDataRows: 1,
            plannedRows: [{ sheet: 'Sheet1', row: 2, rowKey: 'Sheet1::::2' }],
            parsedRows: [2],
            parsedRowItems: [{ sheet: 'Sheet1', row: 2, rowKey: 'Sheet1::::2' }],
            excludedRows: [],
            ambiguousRows: [],
            coveragePct: 100,
            unaccountedRows: [],
          },
          assets: [{ code: 'ACME', name: 'Acme Corp', fund: 'Fund I', txns: [{ currency: 'USD' }] }],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({ id: 'file-1', file_type: 'fund_updates', structured_notes: v1Notes }),
      );

      const catalogSelections = {
        funds: ['Startech Growth Fund 1'],
        investors: ['Investor A'],
        sources: ['Source B'],
      };

      const result = await service.approve('file-1', {
        file_type: 'fund_updates',
        matched_company_id: null,
        fund_update_asset_codes: ['ACME'],
        fund_update_catalog_selections: catalogSelections,
      });

      expect(mockApplyService.applySelected).toHaveBeenCalledWith(
        expect.any(Array),
        ['ACME'],
        undefined,
        { isV1: true, fileId: 'file-1', fundCatalogItems: undefined, executor: expect.anything() },
        catalogSelections,
      );
      expect(result.fund_update).toBeDefined();
    });
  });
});

describe('FileService.getReviewData', () => {
  it('returns current company when proposedCompanyId is present', async () => {
    const fileRepo = makeFileRepoStub();
    const companyService = makeCompanyServiceStub();
    const companyFinancialRepo = makeCompanyFinancialRepoStub();
    const companyFxAdjustmentRepo = makeCompanyFxAdjustmentRepoStub();

    const matchedFile = makeFile({
      id: 'file-1',
      matched_companies: [{ id: 'company-1', name: 'Acme', type: 'company' }] as never,
      structured_notes: JSON.stringify({ file_type: 'prospectus', prospectus_summary: { company_name: 'Acme' } }),
    });
    vi.mocked(fileRepo.findById).mockResolvedValue(matchedFile);
    vi.mocked(companyService.findById).mockResolvedValue(makeCompany({ id: 'company-1' }));

    const service = new FileService(
      null as unknown as DbClient,
      'workspace-1',
      fileRepo,
      makeCompanyAnalysisServiceStub(),
      makeAIScreeningServiceStub(),
      makeCriteriaRepoStub(),
      makeScreeningRepoStub(),
      companyFinancialRepo,
      companyService,
      companyFxAdjustmentRepo,
      makeUserWorkspaceRepoStub(),
    );

    const result = await service.getReviewData('file-1');

    expect(result.kind).toBe('company');
    if (result.kind !== 'company') throw new Error('expected company review');
    expect(result.current.company?.id).toBe('company-1');
  });

  it('returns null current.company when no matched company', async () => {
    const fileRepo = makeFileRepoStub();
    vi.mocked(fileRepo.findById).mockResolvedValue(makeFile({ id: 'file-1', matched_companies: [] }));

    const service = makeService({ fileRepo });
    const result = await service.getReviewData('file-1');

    expect(result.kind).toBe('company');
    if (result.kind !== 'company') throw new Error('expected company review');
    expect(result.current.company).toBeNull();
  });

  it('diffs against the extracted entry matching the proposed company in a multi-company file', async () => {
    const fileRepo = makeFileRepoStub();
    const companyService = makeCompanyServiceStub();

    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({
        id: 'file-1',
        matched_companies: [{ id: 'company-beta', name: 'Beta Ltd', type: 'company' }] as never,
        structured_notes: JSON.stringify({
          file_type: 'shopping_list',
          companies: [
            { company_name: 'Acme Corp', segment: 'Fintech' },
            { company_name: 'Beta Ltd', segment: 'Healthcare' },
          ],
        }),
      }),
    );
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ id: 'company-beta', target: 'Beta Ltd' }),
    );

    const service = makeService({ fileRepo, companyService });
    const result = await service.getReviewData('file-1');

    // The AI side shows Beta's entry — not the file's first entry (Acme).
    expect(result.kind).toBe('company');
    if (result.kind !== 'company') throw new Error('expected company review');
    expect(result.ai.suggested_company).toMatchObject({
      target: 'Beta Ltd',
      segment: 'Healthcare',
    });
  });
});

describe('FileService.getReviewData fund_updates', () => {
  it('throws error when fundUpdateApplyService is not set', async () => {
    const fileRepo = makeFileRepoStub();
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-fu-1', file_type: 'fund_updates' }),
    );
    const service = makeService({ fileRepo });

    await expect(service.getReviewData('file-fu-1')).rejects.toThrow(
      'Fund update apply service is not configured',
    );
  });

  it('includes funds, investors, and sources from buildFullReview for STARTECH-style proposal', async () => {
    const fileRepo = makeFileRepoStub();
    const mockFullReview = {
      assets: [
        {
          code: 'ACME',
          name: 'Acme Corp',
          fund: 'STARTECH I',
          asset_type: 'direct' as const,
          entity: 'HoldCo A',
          funding_source: 'DCA',
          status: 'new' as const,
          matched_asset_id: null,
          matched_fund: { name: 'STARTECH I', status: 'existing' as const, matched_id: 'fund-1' },
          matched_investor: { name: 'HoldCo A', status: 'new' as const, matched_id: null },
          matched_source: { name: 'DCA', status: 'existing' as const, matched_id: 'src-1' },
          proposed_txn_count: 1,
          proposed_valuation_count: 0,
          existing_txn_count: 0,
          existing_valuation_count: 0,
          missing_txn_count: 1,
          missing_valuation_count: 0,
          proposed: {
            code: 'ACME',
            name: 'Acme Corp',
            fund: 'STARTECH I',
            assetType: 'direct' as const,
            entity: 'HoldCo A',
            fundingSource: 'DCA',
            txns: [],
            valuations: [],
          },
          missing_txns: [],
          missing_valuations: [],
        },
      ],
      funds: [{ name: 'STARTECH I', status: 'existing' as const, matched_id: 'fund-1' }],
      investors: [{ name: 'HoldCo A', status: 'new' as const, matched_id: null }],
      sources: [{ name: 'DCA', status: 'existing' as const, matched_id: 'src-1' }],
    };

    const mockApplyService = {
      buildFullReview: vi.fn().mockResolvedValue(mockFullReview),
      buildReview: vi.fn().mockResolvedValue(mockFullReview.assets),
    };

    const notes = JSON.stringify({
      file_type: 'fund_updates',
      parser: 'startech_quarterly',
      summary: 'Q2 2024 report',
      fund_update_proposal: {
        template_id: 'startech_q2_2024',
        stats: { total_assets: 1 },
        assets: mockFullReview.assets.map((a) => a.proposed),
      },
    });

    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-fu-1', file_type: 'fund_updates', structured_notes: notes }),
    );

    const service = makeService({ fileRepo });
    service.setFundUpdateApplyService(mockApplyService as any);

    const result = await service.getReviewData('file-fu-1');

    expect(result.kind).toBe('fund_updates');
    if (result.kind !== 'fund_updates') throw new Error('expected fund_updates');

    expect(mockApplyService.buildFullReview).toHaveBeenCalledTimes(1);
    expect(result.template_id).toBe('startech_q2_2024');
    expect(result.summary).toBe('Q2 2024 report');
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].name).toBe('Acme Corp');
    expect(result.funds).toEqual([
      { name: 'STARTECH I', status: 'existing', matched_id: 'fund-1', asset_codes: ['ACME'] },
    ]);
    expect(result.investors).toEqual([
      { name: 'HoldCo A', status: 'new', matched_id: null, asset_codes: ['ACME'] },
    ]);
    expect(result.sources).toEqual([
      { name: 'DCA', status: 'existing', matched_id: 'src-1', asset_codes: ['ACME'] },
    ]);
  });

  it('merges extra entities from v1 proposal into funds and investors catalogs with asset_codes', async () => {
    const fileRepo = makeFileRepoStub();
    const mockFullReview = {
      assets: [
        {
          code: 'ACME',
          name: 'Acme Corp',
          fund: 'Fund Alpha',
          asset_type: 'direct' as const,
          entity: 'Investor Alpha',
          funding_source: 'DCA',
          status: 'new' as const,
          matched_asset_id: null,
          proposed_txn_count: 1,
          proposed_valuation_count: 0,
          existing_txn_count: 0,
          existing_valuation_count: 0,
          missing_txn_count: 1,
          missing_valuation_count: 0,
          proposed: {
            code: 'ACME',
            name: 'Acme Corp',
            fund: 'Fund Alpha',
            assetType: 'direct' as const,
            entity: 'Investor Alpha',
            fundingSource: 'DCA',
            txns: [],
            valuations: [],
          },
          missing_txns: [],
          missing_valuations: [],
        },
      ],
      funds: [{ name: 'Fund Alpha', status: 'existing' as const, matched_id: 'fund-alpha-id' }],
      investors: [{ name: 'Investor Alpha', status: 'new' as const, matched_id: null }],
      sources: [{ name: 'DCA', status: 'existing' as const, matched_id: 'src-1' }],
    };

    const mockApplyService = {
      buildFullReview: vi.fn().mockResolvedValue(mockFullReview),
    };

    const v1Notes = JSON.stringify({
      file_type: 'fund_updates',
      parser: 'workbook_fallback_v1',
      summary: 'Workbook fallback extraction',
      fund_update_proposal: {
        template_id: 'workbook_fallback_v1',
        schema_version: 'workbook_fallback_v1',
        stats: { asset_count: 1 },
        assets: mockFullReview.assets.map((a) => a.proposed),
        entities: [
          // Extra fund (new)
          { proposalId: 'e-1', entityType: 'fund', originalName: 'Fund Beta' },
          // Existing fund duplicate from asset (case insensitive) -> keep existing status & id
          { proposalId: 'e-2', entityType: 'fund', originalName: 'fund alpha' },
          // Extra investor types
          { proposalId: 'e-3', entityType: 'institutional_investor', originalName: 'Global Pension Fund' },
          { proposalId: 'e-4', entityType: 'individual_investor', originalName: 'Jane Doe', existingRecordId: 'inv-jane' },
          { proposalId: 'e-5', entityType: 'investment_vehicle', originalName: 'SPV Holdings Ltd' },
          { proposalId: 'e-6', entityType: 'investor', originalName: 'investor alpha' }, // duplicate of existing
          // Non-catalog entity types -> must be skipped
          { proposalId: 'e-7', entityType: 'portfolio_company', originalName: 'Beta Tech' },
          { proposalId: 'e-8', entityType: 'fund_or_partnership_asset', originalName: 'Sidecar Vehicle' },
          { proposalId: 'e-9', entityType: 'counterparty', originalName: 'Bank of New York' },
          { proposalId: 'e-10', entityType: 'unknown', originalName: 'Unknown Corp' },
          // Blank entity name -> ignored
          { proposalId: 'e-11', entityType: 'fund', originalName: '   ' },
        ],
      },
    });

    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-v1', file_type: 'fund_updates', structured_notes: v1Notes }),
    );

    const service = makeService({ fileRepo });
    service.setFundUpdateApplyService(mockApplyService as any);

    const result = await service.getReviewData('file-v1');

    expect(result.kind).toBe('fund_updates');
    if (result.kind !== 'fund_updates') throw new Error('expected fund_updates');

    // Funds: Fund Alpha (retains existing status from fullReview + asset_codes) + Fund Beta (new, no asset_codes)
    expect(result.funds).toEqual([
      { name: 'Fund Alpha', status: 'existing', matched_id: 'fund-alpha-id', asset_codes: ['ACME'] },
      { name: 'Fund Beta', status: 'new', matched_id: null, asset_codes: [] },
    ]);

    // Investors: Investor Alpha (new + asset_codes) + others (no asset_codes)
    expect(result.investors).toEqual([
      { name: 'Investor Alpha', status: 'new', matched_id: null, asset_codes: ['ACME'] },
      { name: 'Global Pension Fund', status: 'new', matched_id: null, asset_codes: [] },
      { name: 'Jane Doe', status: 'existing', matched_id: 'inv-jane', asset_codes: [] },
      { name: 'SPV Holdings Ltd', status: 'new', matched_id: null, asset_codes: [] },
    ]);

    // Sources: DCA (unchanged from assets)
    expect(result.sources).toEqual([
      { name: 'DCA', status: 'existing', matched_id: 'src-1', asset_codes: ['ACME'] },
    ]);
  });

  it('links v1 LP to projected assets via fund when capital_contribution has relatedFundRef', async () => {
    const fileRepo = makeFileRepoStub();
    const mockFullReview = {
      assets: [
        {
          code: 'PORTCO_1',
          name: 'Portco One',
          fund: 'Fund F',
          asset_type: 'direct' as const,
          entity: null,
          funding_source: null,
          status: 'new' as const,
          matched_asset_id: null,
          proposed_txn_count: 0,
          proposed_valuation_count: 0,
          existing_txn_count: 0,
          existing_valuation_count: 0,
          missing_txn_count: 0,
          missing_valuation_count: 0,
          proposed: {
            code: 'PORTCO_1',
            name: 'Portco One',
            fund: 'Fund F',
            assetType: 'direct' as const,
            entity: null,
            fundingSource: null,
            txns: [],
            valuations: [],
          },
          missing_txns: [],
          missing_valuations: [],
        },
      ],
      funds: [{ name: 'Fund F', status: 'new' as const, matched_id: null }],
      investors: [],
      sources: [],
    };

    const mockApplyService = {
      buildFullReview: vi.fn().mockResolvedValue(mockFullReview),
    };

    const v1Notes = JSON.stringify({
      file_type: 'fund_updates',
      parser: 'workbook_fallback_v1',
      fund_update_proposal: {
        template_id: 'workbook_fallback_v1',
        schema_version: 'workbook_fallback_v1',
        assets: mockFullReview.assets.map((a) => a.proposed),
        entities: [
          { proposalId: 'ent_lp1', entityType: 'investor', originalName: 'LP Alpha' },
        ],
        events: [
          {
            proposalId: 'ev_1',
            eventType: 'capital_contribution',
            fromEntityRef: 'ent_lp1',
            relatedFundRef: 'Fund F',
          },
        ],
      },
    });

    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-v1-lp', file_type: 'fund_updates', structured_notes: v1Notes }),
    );

    const service = makeService({ fileRepo });
    service.setFundUpdateApplyService(mockApplyService as any);

    const result = await service.getReviewData('file-v1-lp');

    expect(result.kind).toBe('fund_updates');
    if (result.kind !== 'fund_updates') throw new Error('expected fund_updates');

    expect(result.investors).toEqual([
      { name: 'LP Alpha', status: 'new', matched_id: null, asset_codes: ['PORTCO_1'] },
    ]);
    expect(result.funds).toEqual([
      { name: 'Fund F', status: 'new', matched_id: null, asset_codes: ['PORTCO_1'] },
    ]);
  });

  it('hydrates parsed assets before calling buildFullReview for v1 proposal', async () => {
    const fileRepo = makeFileRepoStub();
    const mockApplyService = {
      buildFullReview: vi.fn().mockImplementation((assets) =>
        Promise.resolve({
          assets: assets.map((a: any) => ({
            code: a.code,
            name: a.name,
            fund: a.fund,
            entity: a.entity,
            funding_source: a.fundingSource,
            status: 'new',
            matched_asset_id: null,
            proposed_txn_count: 0,
            proposed_valuation_count: 0,
            existing_txn_count: 0,
            existing_valuation_count: 0,
            missing_txn_count: 0,
            missing_valuation_count: 0,
            proposed: a,
            missing_txns: [],
            missing_valuations: [],
          })),
          funds: [{ name: 'Fund X', status: 'new', matched_id: null }],
          investors: [{ name: 'Holding Corp', status: 'new', matched_id: null }],
          sources: [],
        }),
      ),
    };

    const v1Notes = JSON.stringify({
      file_type: 'fund_updates',
      parser: 'workbook_fallback_v1',
      fund_update_proposal: {
        template_id: 'workbook_fallback_v1',
        schema_version: 'workbook_fallback_v1',
        assets: [{ code: 'PORT_A', name: 'Port A', fund: '', entity: '', txns: [], valuations: [] }],
        entities: [
          { proposalId: 'ent_h', entityType: 'investment_vehicle', originalName: 'Holding Corp' },
          { proposalId: 'ent_f', entityType: 'fund', originalName: 'Fund X' },
        ],
        events: [
          {
            proposalId: 'ev_1',
            eventType: 'asset_investment',
            fromEntityRef: 'ent_h',
            toEntityRef: 'PORT_A',
            relatedFundRef: 'Fund X',
          },
        ],
      },
    });

    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-v1-hydrate', file_type: 'fund_updates', structured_notes: v1Notes }),
    );

    const service = makeService({ fileRepo });
    service.setFundUpdateApplyService(mockApplyService as any);

    const result = await service.getReviewData('file-v1-hydrate');

    expect(result.kind).toBe('fund_updates');
    if (result.kind !== 'fund_updates') throw new Error('expected fund_updates');

    // buildFullReview received the hydrated assets
    expect(mockApplyService.buildFullReview).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          code: 'PORT_A',
          name: 'Port A',
          fund: 'Fund X',
          entity: 'Holding Corp',
        }),
      ],
      [],
      expect.any(Object),
    );
  });

  it('returns empty catalog arrays when proposal has no assets and no entities', async () => {
    const fileRepo = makeFileRepoStub();
    const mockApplyService = {
      buildFullReview: vi.fn().mockResolvedValue({ assets: [], funds: [], investors: [], sources: [] }),
    };

    const notes = JSON.stringify({
      file_type: 'fund_updates',
      parser: 'startech_quarterly',
      fund_update_proposal: {
        template_id: 'startech_q2_2024',
        assets: [],
      },
    });

    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-empty', file_type: 'fund_updates', structured_notes: notes }),
    );

    const service = makeService({ fileRepo });
    service.setFundUpdateApplyService(mockApplyService as any);

    const result = await service.getReviewData('file-empty');

    expect(result.kind).toBe('fund_updates');
    if (result.kind !== 'fund_updates') throw new Error('expected fund_updates');

    expect(result.assets).toEqual([]);
    expect(result.funds).toEqual([]);
    expect(result.investors).toEqual([]);
    expect(result.sources).toEqual([]);
  });

  it('preserves auto_created flag on catalog matches in getReviewData', async () => {
    const fileRepo = makeFileRepoStub();
    const mockFullReview = {
      assets: [
        {
          code: 'ACME',
          name: 'Acme Corp',
          fund: 'Startech Growth Fund 1',
          asset_type: 'direct' as const,
          entity: 'Investor Alpha',
          funding_source: 'DCA',
          status: 'new' as const,
          matched_asset_id: null,
          matched_fund: { name: 'Startech Growth Fund 1', status: 'existing' as const, matched_id: 'f-1', auto_created: true },
          matched_investor: { name: 'Investor Alpha', status: 'new' as const, matched_id: null },
          matched_source: { name: 'DCA', status: 'existing' as const, matched_id: 'src-1' },
          proposed_txn_count: 1,
          proposed_valuation_count: 0,
          existing_txn_count: 0,
          existing_valuation_count: 0,
          missing_txn_count: 1,
          missing_valuation_count: 0,
          proposed: {
            code: 'ACME',
            name: 'Acme Corp',
            fund: 'Startech Growth Fund 1',
            assetType: 'direct' as const,
            entity: 'Investor Alpha',
            fundingSource: 'DCA',
            txns: [],
            valuations: [],
          },
          missing_txns: [],
          missing_valuations: [],
        },
      ],
      funds: [
        { name: 'Startech Growth Fund 1', status: 'existing' as const, matched_id: 'f-1', auto_created: true },
        { name: 'Custom Fund', status: 'new' as const, matched_id: null },
      ],
      investors: [{ name: 'Investor Alpha', status: 'new' as const, matched_id: null }],
      sources: [{ name: 'DCA', status: 'existing' as const, matched_id: 'src-1' }],
    };

    const mockApplyService = {
      buildFullReview: vi.fn().mockResolvedValue(mockFullReview),
    };

    const notes = JSON.stringify({
      file_type: 'fund_updates',
      parser: 'startech_quarterly',
      fund_update_proposal: {
        template_id: 'startech_q2_2024',
        assets: mockFullReview.assets.map((a) => a.proposed),
      },
    });

    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-auto-created', file_type: 'fund_updates', structured_notes: notes }),
    );

    const service = makeService({ fileRepo });
    service.setFundUpdateApplyService(mockApplyService as any);

    const result = await service.getReviewData('file-auto-created');
    if (result.kind !== 'fund_updates') throw new Error('expected fund_updates');

    const catFund = result.funds.find((f) => f.name === 'Startech Growth Fund 1');
    expect(catFund?.auto_created).toBe(true);

    const nonCatFund = result.funds.find((f) => f.name === 'Custom Fund');
    expect(nonCatFund?.auto_created).toBeUndefined();
  });
  it('forwards commitment_events from proposal into buildFullReview', async () => {
    const fileRepo = makeFileRepoStub();
    const mockApplyService = {
      buildFullReview: vi.fn().mockResolvedValue({
        assets: [],
        funds: [],
        investors: [],
        sources: [],
      }),
    };
    const commitmentEvents = [
      {
        fund: 'Fund A',
        investorName: 'Investor A',
        investorTypeRaw: '机构投资人',
        investorTypeLabel: 'Institutional Investor',
        date: '2024-01-15',
        intent: 'increase' as const,
        amount: 1000000,
        currency: 'CNY' as const,
        counterpartyName: null,
        actionRaw: '认缴',
        natureRaw: '新增额度',
        directionRaw: '认缴额度增加',
        notes: null,
        sourceRow: 3,
      },
    ];
    const notes = JSON.stringify({
      file_type: 'fund_updates',
      parser: 'nanjing_fund_ledger_v1',
      fund_update_proposal: {
        template_id: 'nanjing_fund_ledger_v1',
        assets: [{ code: 'NJ-01', name: 'Asset 1', fund: 'Fund A', txns: [] }],
        commitment_events: commitmentEvents,
      },
    });
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-nanjing-review', file_type: 'fund_updates', structured_notes: notes }),
    );
    const service = makeService({ fileRepo });
    service.setFundUpdateApplyService(mockApplyService as any);
    await service.getReviewData('file-nanjing-review');
    expect(mockApplyService.buildFullReview).toHaveBeenCalledWith(
      expect.any(Array),
      commitmentEvents,
      expect.any(Object),
    );
  });

  it('threads reconciliation and review_items from proposal to getReviewData', async () => {
    const fileRepo = makeFileRepoStub();
    const mockApplyService = {
      buildFullReview: vi.fn().mockResolvedValue({
        assets: [],
        funds: [],
        investors: [],
        sources: [],
        reconciliation: [{ metricName: 'Net Commitment', sourceValue: 100, calculatedValue: 100, diff: 0, diffPct: 0, isReconciled: true }],
        review_items: [{ sourceRow: 5, fund: 'Fund A', investorName: 'LP 1', date: '2024-01-01', amount: 50, currency: 'CNY', action: '实缴调整', nature: '损益核销', direction: '非现金调整', explanation: 'Manual review required', isPostable: false, requiresReview: true }],
      }),
    };
    const notes = JSON.stringify({
      file_type: 'fund_updates',
      parser: 'nanjing_fund_ledger_v1',
      fund_update_proposal: {
        template_id: 'nanjing_fund_ledger_v1',
        assets: [],
        commitment_events: [{
          fund: 'Fund A',
          investorName: 'Investor A',
          investorTypeRaw: '机构投资人',
          investorTypeLabel: 'Institutional Investor',
          date: '2024-01-02',
          intent: 'transfer_in',
          amount: 50,
          currency: 'CNY',
          counterpartyName: 'Unverified transferor',
          actionRaw: '认缴',
          natureRaw: '受让额度',
          directionRaw: '认缴额度增加',
          notes: null,
          sourceRow: 6,
          transferPairing: {
            status: 'unknown_counterparty',
            transferorName: null,
            counterpartyRaw: 'Unverified transferor',
            matchedReductionSourceRow: null,
            eligibleForTransferOut: false,
            requiresReview: true,
            reviewReason: 'Transferor requires verification.',
          },
        }],
        reconciliation: [{ metricName: 'Net Commitment', sourceValue: 100, calculatedValue: 100, diff: 0, diffPct: 0, isReconciled: true }],
        review_items: [{ sourceRow: 5, fund: 'Fund A', investorName: 'LP 1', date: '2024-01-01', amount: 50, currency: 'CNY', action: '实缴调整', nature: '损益核销', direction: '非现金调整', explanation: 'Manual review required', isPostable: false, requiresReview: true }],
      },
    });
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-nanjing-recon', file_type: 'fund_updates', structured_notes: notes }),
    );
    const service = makeService({ fileRepo });
    service.setFundUpdateApplyService(mockApplyService as any);
    const review = await service.getReviewData('file-nanjing-recon');
    expect(review.kind).toBe('fund_updates');
    if (review.kind !== 'fund_updates') throw new Error('expected fund_updates');
    expect(review.reconciliation).toHaveLength(1);
    expect(review.reconciliation![0].metricName).toBe('Net Commitment');
    expect(review.review_items).toHaveLength(2);
    expect(review.review_items![0].action).toBe('实缴调整');
    expect(review.review_items![1]).toMatchObject({
      sourceRow: 6,
      action: 'Commitment transfer',
      isPostable: false,
    });
  });

  it('surfaces valid unknown transfer counterparty in review.investors with Transfer Counterparty role instead of review_items', async () => {
    const fileRepo = makeFileRepoStub();
    const mockApplyService = {
      buildFullReview: vi.fn().mockImplementation((_assets, commitmentEvents) => {
        const investors = [
          { name: 'Investor A', status: 'new' as const, matched_id: null },
          { name: 'New Counterparty LP', status: 'new' as const, matched_id: null, role: 'Transfer Counterparty' },
        ];
        return Promise.resolve({
          assets: [],
          funds: [],
          investors,
          sources: [],
        });
      }),
    };

    const notes = JSON.stringify({
      file_type: 'fund_updates',
      parser: 'nanjing_fund_ledger_v1',
      fund_update_proposal: {
        template_id: 'nanjing_fund_ledger_v1',
        assets: [],
        commitment_events: [{
          fund: 'Fund A',
          investorName: 'Investor A',
          investorTypeRaw: '机构投资人',
          investorTypeLabel: 'Institutional Investor',
          date: '2024-01-02',
          intent: 'transfer_in',
          amount: 50,
          currency: 'CNY',
          counterpartyName: 'New Counterparty LP',
          actionRaw: '认缴',
          natureRaw: '受让额度',
          directionRaw: '认缴额度增加',
          notes: null,
          sourceRow: 6,
          transferPairing: {
            status: 'unknown_counterparty',
            transferorName: 'New Counterparty LP',
            counterpartyRaw: 'New Counterparty LP',
            matchedReductionSourceRow: null,
            eligibleForTransferOut: true,
            requiresReview: false,
            reviewReason: null,
          },
        }],
        review_items: [],
      },
    });
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-nanjing-cp', file_type: 'fund_updates', structured_notes: notes }),
    );
    const service = makeService({ fileRepo });
    service.setFundUpdateApplyService(mockApplyService as any);
    const review = await service.getReviewData('file-nanjing-cp');

    expect(review.kind).toBe('fund_updates');
    if (review.kind !== 'fund_updates') throw new Error('expected fund_updates');

    // Valid unknown counterparty is NOT placed in review_items as non-postable
    expect(review.review_items).toEqual([]);

    // Surfaced in investors catalog with role metadata
    expect(review.investors).toHaveLength(2);
    const cp = review.investors.find((i) => i.name === 'New Counterparty LP');
    expect(cp).toBeDefined();
    expect(cp?.role).toBe('Transfer Counterparty');
    expect(cp?.status).toBe('new');
  });

  it('forwards fund_update_catalog_selections to applyCommitmentEvents on approve', async () => {
    const fileRepo = makeFileRepoStub();
    const mockApplyService = {
      applySelected: vi.fn().mockResolvedValue({
        applied: 0,
        created_assets: 0,
        updated_assets: 0,
        skipped: 0,
        txns_inserted: 0,
        valuations_upserted: 0,
        created_funds: 0,
        created_investors: 1,
        created_sources: 0,
      }),
      applyCommitmentEvents: vi.fn().mockResolvedValue({
        events_inserted: 1,
        events_skipped_duplicate: 0,
        events_skipped: 0,
        warnings: [],
      }),
    };

    const notes = JSON.stringify({
      file_type: 'fund_updates',
      parser: 'nanjing_fund_ledger_v1',
      fund_update_proposal: {
        template_id: 'nanjing_fund_ledger_v1',
        assets: [],
        fund_catalog: ['Fund A'],
        commitment_events: [{
          fund: 'Fund A',
          investorName: 'Investor A',
          date: '2024-01-02',
          intent: 'transfer_in',
          amount: 50,
          currency: 'CNY',
          sourceRow: 6,
          transferPairing: {
            status: 'unknown_counterparty',
            transferorName: 'New Counterparty LP',
            eligibleForTransferOut: true,
            requiresReview: false,
          },
        }],
      },
    });
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-nanjing-approve', file_type: 'fund_updates', structured_notes: notes }),
    );
    const service = makeService({ fileRepo });
    service.setFundUpdateApplyService(mockApplyService as any);

    await service.approve('file-nanjing-approve', {
      file_type: 'fund_updates',
      matched_company_id: null,
      fund_update_asset_codes: [],
      fund_update_catalog_selections: {
        funds: ['Fund A'],
        investors: ['Investor A', 'New Counterparty LP'],
        sources: [],
      },
    });

    expect(mockApplyService.applyCommitmentEvents).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        catalogSelections: {
          funds: ['Fund A'],
          investors: ['Investor A', 'New Counterparty LP'],
          sources: [],
        },
      }),
    );
  });

  it('triggers hitl review for proposals with review_items or commitment_events even with 0 assets', async () => {
    const fileRepo = makeFileRepoStub();
    const mockApplyService = {
      buildReview: vi.fn().mockResolvedValue([]),
    };
    const service = makeService({ fileRepo });
    service.setFundUpdateApplyService(mockApplyService as any);

    // 1. review_items with 0 assets
    const proposalWithReviewItems = {
      file_type: 'fund_updates' as const,
      fund_update_proposal: {
        template_id: 'nanjing_fund_ledger_v1',
        assets: [],
        review_items: [{ sourceRow: 5, fund: 'Fund A', investorName: 'LP 1', date: '2024-01-01', amount: 50, currency: 'CNY' as const, action: '实缴调整', nature: null, direction: null, explanation: 'Manual review', isPostable: false as const, requiresReview: true as const }],
      },
    };
    const needsReview1 = await (service as any).fundUpdateProposalNeedsReview(proposalWithReviewItems);
    expect(needsReview1).toBe(true);

    // 2. commitment_events with 0 assets
    const proposalWithCommitmentEvents = {
      file_type: 'fund_updates' as const,
      fund_update_proposal: {
        template_id: 'nanjing_fund_ledger_v1',
        assets: [],
        commitment_events: [{ fund: 'Fund A', investorName: 'LP 1', investorTypeRaw: 'LP', investorTypeLabel: 'LP', date: '2024-01-01', intent: 'increase' as const, amount: 100, currency: 'CNY' as const, counterpartyName: null, actionRaw: '认缴', natureRaw: '新增', directionRaw: '增加', notes: null, sourceRow: 2 }],
      },
    };
    const needsReview2 = await (service as any).fundUpdateProposalNeedsReview(proposalWithCommitmentEvents);
    expect(needsReview2).toBe(true);

    // 3. 0 assets, 0 events, 0 review_items -> false
    const emptyProposal = {
      file_type: 'fund_updates' as const,
      fund_update_proposal: {
        template_id: 'nanjing_fund_ledger_v1',
        assets: [],
        commitment_events: [],
        review_items: [],
      },
    };
    const needsReview3 = await (service as any).fundUpdateProposalNeedsReview(emptyProposal);
    expect(needsReview3).toBe(false);
  });

  it('links a Nanjing investor to every asset booked under their committed fund (MB-485 regression)', async () => {
    const fileRepo = makeFileRepoStub();

    const commitmentEvents = [
      {
        fund: 'Fund A',
        investorName: 'Investor A',
        investorTypeRaw: '机构投资人',
        investorTypeLabel: 'Institutional Investor',
        date: '2024-01-15',
        intent: 'increase' as const,
        amount: 1000000,
        currency: 'CNY' as const,
        counterpartyName: null,
        actionRaw: '认缴',
        natureRaw: '新增额度',
        directionRaw: '认缴额度增加',
        notes: null,
        sourceRow: 3,
      },
    ];

    const mockApplyService = {
      buildFullReview: vi.fn().mockResolvedValue({
        assets: [
          {
            code: 'NJ-01',
            name: 'Asset 1',
            fund: 'Fund A',
            asset_type: 'direct_investment',
            entity: null,
            funding_source: null,
            matched_fund: null,
            matched_investor: null,
            matched_source: null,
            status: 'new',
            matched_asset_id: null,
            proposed_txn_count: 0,
            proposed_valuation_count: 0,
            existing_txn_count: 0,
            existing_valuation_count: 0,
            missing_txn_count: 0,
            missing_valuation_count: 0,
            proposed: { code: 'NJ-01', name: 'Asset 1', fund: 'Fund A', txns: [] },
            proposed_txns: [],
            proposed_valuations: [],
          },
        ],
        funds: [{ name: 'Fund A', status: 'new', matched_id: null }],
        investors: [{ name: 'Investor A', status: 'new', matched_id: null }],
        sources: [],
      }),
    };

    const notes = JSON.stringify({
      file_type: 'fund_updates',
      parser: 'nanjing_fund_ledger_v1',
      fund_update_proposal: {
        template_id: 'nanjing_fund_ledger_v1',
        assets: [{ code: 'NJ-01', name: 'Asset 1', fund: 'Fund A', txns: [] }],
        commitment_events: commitmentEvents,
      },
    });

    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-nanjing-link', file_type: 'fund_updates', structured_notes: notes }),
    );

    const service = makeService({ fileRepo });
    service.setFundUpdateApplyService(mockApplyService as any);

    const result = await service.getReviewData('file-nanjing-link');

    expect(result.kind).toBe('fund_updates');
    if (result.kind !== 'fund_updates') throw new Error('expected fund_updates');

    // Before the MB-485 fix this was always [] for deterministic-parser proposals,
    // because linkEvents only ever came from the workbook_fallback_v1 schema.
    expect(result.investors[0]?.asset_codes).toEqual(['NJ-01']);
  });
});
describe('FileService.approve (fund_updates commitment events)', () => {
  it('approves Nanjing events despite advisory reconciliation and unresolved transfers', async () => {
    const fileRepo = makeFileRepoStub();
    const mockApplyService = {
      applySelected: vi.fn().mockResolvedValue({
        applied: 1,
        created_assets: 1,
        updated_assets: 0,
        skipped: 0,
        txns_inserted: 1,
        valuations_upserted: 0,
      }),
      applyCommitmentEvents: vi.fn().mockResolvedValue({
        events_inserted: 2,
        events_skipped_duplicate: 1,
        events_skipped: 0,
        warnings: ['Some warning'],
      }),
      buildReview: vi.fn().mockResolvedValue([]),
    };
    const commitmentEvents = [
      {
        fund: 'Fund A',
        investorName: 'Investor A',
        investorTypeRaw: '机构投资人',
        investorTypeLabel: 'Institutional Investor',
        date: '2024-01-15',
        intent: 'transfer_in' as const,
        amount: 1000000,
        currency: 'CNY' as const,
        counterpartyName: null,
        actionRaw: '认缴',
        natureRaw: '新增额度',
        directionRaw: '认缴额度增加',
        notes: null,
        sourceRow: 3,
        transferPairing: {
          status: 'unknown_counterparty' as const,
          transferorName: null,
          counterpartyRaw: 'Unverified transferor',
          matchedReductionSourceRow: null,
          eligibleForTransferOut: false,
          requiresReview: true,
          reviewReason: 'Transferor requires verification.',
        },
      },
    ];
    const notes = JSON.stringify({
      file_type: 'fund_updates',
      parser: 'nanjing_fund_ledger_v1',
      fund_update_proposal: {
        template_id: 'nanjing_fund_ledger_v1',
        stats: { asset_count: 1, commitment_event_count: 1 },
        assets: [{ code: 'NJ-01', name: 'Asset 1', fund: 'Fund A', txns: [] }],
        fund_catalog: ['Fund A'],
        // Summary totals are cumulative, while this upload can contain a
        // partial commitment or staged capital call. Reconciliation remains
        // review information and must not prevent posting this valid event.
        reconciliation: [{
          metricName: 'Paid-in Capital vs Summary',
          fund: 'Fund A',
          sourceValue: 10_000_000,
          calculatedValue: 1_000_000,
          diff: -9_000_000,
          diffPct: 90,
          currency: 'CNY',
          unit: 'CNY',
          isReconciled: false,
          sheet: '基金汇总 / 基金流水明细',
          notes: 'Partial capital call in this upload.',
        }],
        commitment_events: commitmentEvents,
      },
    });
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-nanjing', file_type: 'fund_updates', structured_notes: notes }),
    );
    const service = makeService({ fileRepo });
    service.setFundUpdateApplyService(mockApplyService as any);
    const res = await service.approve(
      'file-nanjing',
      {
        file_type: 'fund_updates',
        matched_company_id: null,
        fund_update_asset_codes: ['NJ-01'],
      },
      '8cbd7aa4-dd0b-4e16-9512-4961c3223d29',
    );
    expect(mockApplyService.applySelected).toHaveBeenCalledTimes(1);
    expect(mockApplyService.applyCommitmentEvents).toHaveBeenCalledWith(
      commitmentEvents,
      {
        source: 'nanjing_fund_ledger_v1',
        fundCatalog: ['Fund A'],
        fundCatalogItems: undefined,
        fileId: 'file-nanjing',
        createdBy: '8cbd7aa4-dd0b-4e16-9512-4961c3223d29',
        catalogSelections: undefined,
        reviewResolutions: undefined,
        reviewItems: [
          expect.objectContaining({
            sourceRow: 3,
            category: 'missing_counterparty',
            action: 'Commitment transfer',
          }),
        ],
        executor: expect.anything(),
      },
    );
    expect(res.fund_update).toEqual({
      applied: 1,
      created_assets: 1,
      updated_assets: 0,
      skipped: 0,
      txns_inserted: 1,
      valuations_upserted: 0,
      commitment_events_inserted: 2,
      commitment_events_skipped_duplicate: 1,
      commitment_events_skipped: 0,
      commitment_event_warnings: ['Some warning'],
    });
  });
  it('never calls applyCommitmentEvents for a v1 (workbook_fallback_v1) proposal', async () => {
    const fileRepo = makeFileRepoStub();
    const mockApplyService = {
      applySelected: vi.fn().mockResolvedValue({
        applied: 1,
        created_assets: 1,
        updated_assets: 0,
        skipped: 0,
        txns_inserted: 1,
        valuations_upserted: 0,
      }),
      applyCommitmentEvents: vi.fn(),
      buildReview: vi.fn().mockResolvedValue([]),
    };
    const v1Notes = JSON.stringify({
      file_type: 'fund_updates',
      parser: 'workbook_fallback_v1',
      fund_update_proposal: {
        schema_version: 'workbook_fallback_v1',
        stats: { total_data_rows: 1 },
        interpretation: { currencies: [{ sourceCurrency: 'USD', sourceUnit: '1', multiplier: 1 }] },
        entities: [{ proposalId: 'ent_1', entityType: 'portfolio_company', originalName: 'Acme Corp' }],
        events: [{
          eventType: 'asset_investment',
          sourceAction: '投资',
          relatedFundRef: 'Fund I',
          sourceCurrency: 'USD',
          normalizedCurrency: 'USD',
          sourceUnit: 'USD',
          amountMultiplier: 1,
          sourceAmount: 100,
          normalizedAmount: 100,
          sourceLocation: { sheet: 'Sheet1', row: 2 },
        }],
        valuations: [],
        row_accounting: {
          totalDataRows: 1,
          plannedRows: [{ sheet: 'Sheet1', row: 2, rowKey: 'Sheet1::::2' }],
          parsedRows: [2],
          parsedRowItems: [{ sheet: 'Sheet1', row: 2, rowKey: 'Sheet1::::2' }],
          excludedRows: [],
          ambiguousRows: [],
          coveragePct: 100,
          unaccountedRows: [],
        },
        assets: [{ code: 'ACME', name: 'Acme Corp', fund: 'Fund I', txns: [{ currency: 'USD' }] }],
      },
    });
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-v1', file_type: 'fund_updates', structured_notes: v1Notes }),
    );
    const service = makeService({ fileRepo });
    service.setFundUpdateApplyService(mockApplyService as any);
    await service.approve('file-v1', {
      file_type: 'fund_updates',
      matched_company_id: null,
      fund_update_asset_codes: ['ACME'],
    });
    expect(mockApplyService.applyCommitmentEvents).not.toHaveBeenCalled();
  });
  it('never calls applyCommitmentEvents for a proposal without commitment_events', async () => {
    const fileRepo = makeFileRepoStub();
    const mockApplyService = {
      applySelected: vi.fn().mockResolvedValue({
        applied: 1,
        created_assets: 1,
        updated_assets: 0,
        skipped: 0,
        txns_inserted: 1,
        valuations_upserted: 0,
      }),
      applyCommitmentEvents: vi.fn(),
      buildReview: vi.fn().mockResolvedValue([]),
    };
    const notes = JSON.stringify({
      file_type: 'fund_updates',
      parser: 'startech_quarterly',
      fund_update_proposal: {
        template_id: 'startech_q2_2024',
        stats: { total_assets: 1 },
        assets: [{ code: 'ACME', name: 'Acme Corp', fund: 'Fund I', txns: [] }],
      },
    });
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-startech', file_type: 'fund_updates', structured_notes: notes }),
    );
    const service = makeService({ fileRepo });
    service.setFundUpdateApplyService(mockApplyService as any);
    await service.approve('file-startech', {
      file_type: 'fund_updates',
      matched_company_id: null,
      fund_update_asset_codes: ['ACME'],
    });
    expect(mockApplyService.applyCommitmentEvents).not.toHaveBeenCalled();
  });
});

describe('FileService.delete', () => {
  it('deletes the S3 file then the DB record', async () => {
    const fileRepo = makeFileRepoStub();
    vi.mocked(fileRepo.findLinkAndNameById).mockResolvedValue({
      file_link: 'uploads/report.pdf',
      file_name: 'report.pdf',
    });
    const service = makeService({ fileRepo });

    await service.delete('file-1');

    expect(deleteFile).toHaveBeenCalledWith('uploads/report.pdf');
    expect(fileRepo.delete).toHaveBeenCalledWith('file-1');
  });

  it('still deletes the DB record when S3 deletion throws', async () => {
    const fileRepo = makeFileRepoStub();
    vi.mocked(fileRepo.findLinkAndNameById).mockResolvedValue({
      file_link: 'uploads/report.pdf',
      file_name: 'report.pdf',
    });
    vi.mocked(deleteFile).mockRejectedValue(new Error('S3 error'));
    const service = makeService({ fileRepo });

    await service.delete('file-1');

    expect(fileRepo.delete).toHaveBeenCalledWith('file-1');
  });
});

describe('FileService.findAll', () => {
  it('returns files with signed URLs', async () => {
    const fileRepo = makeFileRepoStub();
    vi.mocked(fileRepo.findAll).mockResolvedValue([makeFile({ id: 'file-1' })]);
    vi.mocked(getSignedUrl).mockResolvedValue('https://signed-url');
    const service = makeService({ fileRepo });

    const result = await service.findAll();

    expect(result[0]).toMatchObject({ id: 'file-1', signed_url: 'https://signed-url' });
  });

  it('returns signed_url as null when getSignedUrl throws', async () => {
    const fileRepo = makeFileRepoStub();
    vi.mocked(fileRepo.findAll).mockResolvedValue([makeFile({ id: 'file-1' })]);
    vi.mocked(getSignedUrl).mockRejectedValue(new Error('S3 error'));
    const service = makeService({ fileRepo });

    const result = await service.findAll();

    expect(result[0]).toMatchObject({ id: 'file-1', signed_url: null });
  });
});

describe('FileService.list', () => {
  it('returns the page rows with signed URLs alongside the total', async () => {
    const fileRepo = makeFileRepoStub();
    vi.mocked(fileRepo.listPaginated).mockResolvedValue({
      rows: [makeFile({ id: 'file-1' })],
      total: 7,
    });
    vi.mocked(getSignedUrl).mockResolvedValue('https://signed-url');
    const service = makeService({ fileRepo });

    const result = await service.list({ limit: 10, offset: 0 });

    expect(result.total).toBe(7);
    expect(result.data[0]).toMatchObject({ id: 'file-1', signed_url: 'https://signed-url' });
  });

  it('sets signed_url to null for a page row when signing fails', async () => {
    const fileRepo = makeFileRepoStub();
    vi.mocked(fileRepo.listPaginated).mockResolvedValue({
      rows: [makeFile({ id: 'file-1' })],
      total: 1,
    });
    vi.mocked(getSignedUrl).mockRejectedValue(new Error('S3 error'));
    const service = makeService({ fileRepo });

    const result = await service.list({ limit: 10, offset: 0 });

    expect(result.data[0]).toMatchObject({ id: 'file-1', signed_url: null });
  });

  it('forwards the search, sort and pagination options to the repository', async () => {
    const fileRepo = makeFileRepoStub();
    vi.mocked(fileRepo.listPaginated).mockResolvedValue({ rows: [], total: 0 });
    const service = makeService({ fileRepo });

    await service.list({
      fileType: 'prospectus',
      search: 'acme',
      sortField: 'file_name',
      sortDirection: 'asc',
      limit: 20,
      offset: 40,
    });

    expect(fileRepo.listPaginated).toHaveBeenCalledWith({
      fileType: 'prospectus',
      search: 'acme',
      sortField: 'file_name',
      sortDirection: 'asc',
      limit: 20,
      offset: 40,
    });
  });

  it('skips signing entirely when skipSignedUrls is set', async () => {
    const fileRepo = makeFileRepoStub();
    const row = makeFile({ id: 'file-1' });
    vi.mocked(fileRepo.listPaginated).mockResolvedValue({ rows: [row], total: 1 });
    const service = makeService({ fileRepo });

    const result = await service.list({ limit: 10, offset: 0, skipSignedUrls: true });

    expect(result.data).toEqual([row]);
    expect(getSignedUrl).not.toHaveBeenCalled();
  });
});

describe('FileService.countsByType', () => {
  it('forwards the search term to the repository', async () => {
    const fileRepo = makeFileRepoStub();
    vi.mocked(fileRepo.countsByType).mockResolvedValue({ mom: 0, other: 2 });
    const service = makeService({ fileRepo });

    const result = await service.countsByType('acme');

    expect(fileRepo.countsByType).toHaveBeenCalledWith('acme');
    expect(result).toEqual({ mom: 0, other: 2 });
  });
});

describe('FileService.reprocess', () => {
  let fileRepo: FileRepository;
  let companyService: CompanyService;
  let companyFinancialRepo: CompanyFinancialRepository;
  let service: FileService;

  beforeEach(() => {
    fileRepo = makeFileRepoStub();
    companyService = makeCompanyServiceStub();
    companyFinancialRepo = makeCompanyFinancialRepoStub();
    service = makeService({ fileRepo, companyService, companyFinancialRepo });

    vi.mocked(downloadFile).mockResolvedValue(Buffer.from('content'));
    vi.mocked(getSignedUrl).mockResolvedValue('https://signed-url');
    vi.mocked(processFileContent).mockResolvedValue(null);
    // findById is called twice: once to load the existing row, once to return
    // the refreshed row. Default both to a completed 'other' file.
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_type: 'other', processing_status: 'completed' }),
    );
  });

  it('re-downloads the existing file by its stored S3 key', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_link: 'uploads/report.pdf', file_name: 'report.pdf' }),
    );

    await service.reprocess('file-1');

    expect(downloadFile).toHaveBeenCalledWith('uploads/report.pdf');
  });

  it('never inserts a new file row (updates in place)', async () => {
    await service.reprocess('file-1');

    expect(fileRepo.insert).not.toHaveBeenCalled();
  });

  it('marks the file as processing before running the agent', async () => {
    await service.reprocess('file-1');

    expect(fileRepo.updatePartial).toHaveBeenNthCalledWith(
      1,
      'file-1',
      expect.objectContaining({ processing_status: 'processing' }),
    );
  });

  it('skips text extraction for PDF files (detected via filename)', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_name: 'report.pdf', file_type: 'other' }),
    );

    await service.reprocess('file-1');

    expect(extractTextFromFile).not.toHaveBeenCalled();
  });

  it('reconstructs the content type from the filename and passes application/pdf for PDFs', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_name: 'report.pdf', file_type: 'other' }),
    );

    await service.reprocess('file-1');

    const lastCallArgs = vi.mocked(processFileContent).mock.calls.at(-1);
    // args: rawText=0, buffer=1, contentType=2, rawNotes=3, fileTypeOverride=4
    expect(lastCallArgs?.[2]).toBe('application/pdf');
  });

  it('extracts text for non-PDF files using the derived content type', async () => {
    vi.mocked(extractTextFromFile).mockResolvedValue('extracted text');
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_name: 'notes.docx', file_type: 'mom' }),
    );

    await service.reprocess('file-1');

    expect(extractTextFromFile).toHaveBeenCalledWith(
      expect.any(Buffer),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'notes.docx',
    );
  });

  it('passes the stored file_type as the agent override when it is a valid override', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_name: 'notes.pdf', file_type: 'mom' }),
    );

    await service.reprocess('file-1');

    const lastCallArgs = vi.mocked(processFileContent).mock.calls.at(-1);
    expect(lastCallArgs?.[4]).toBe('mom');
  });

  it('passes no override for file types outside the override union', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_name: 'emails.mbox', file_type: 'banker_communications' }),
    );

    await service.reprocess('file-1');

    const lastCallArgs = vi.mocked(processFileContent).mock.calls.at(-1);
    expect(lastCallArgs?.[4]).toBeUndefined();
  });

  it('refreshes raw_notes, structured_notes, tags, matched_companies and file_date', async () => {
    vi.mocked(extractTextFromFile).mockResolvedValue('fresh text');
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_name: 'notes.docx', file_type: 'mom' }),
    );
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'mom',
      tags: ['acme', 'q3'],
      matched_companies: [{ id: 'company-1', type: 'company' }],
      file_date: '2026-01-15',
    } as never);

    await service.reprocess('file-1');

    expect(fileRepo.updatePartial).toHaveBeenLastCalledWith(
      'file-1',
      expect.objectContaining({
        raw_notes: 'fresh text',
        tags: ['acme', 'q3'],
        matched_companies: [{ id: 'company-1', type: 'company' }],
        file_date: '2026-01-15',
        structured_notes: expect.stringContaining('"file_type": "mom"'),
      }),
    );
  });

  it('does not change the stored file_type', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_name: 'notes.pdf', file_type: 'mom' }),
    );
    vi.mocked(processFileContent).mockResolvedValue({ file_type: 'prospectus' } as never);

    await service.reprocess('file-1');

    const finalUpdate = vi.mocked(fileRepo.updatePartial).mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(finalUpdate.file_type).toBeUndefined();
  });

  it('completes prospectus files (no review gate)', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_name: 'teaser.pdf', file_type: 'prospectus' }),
    );

    await service.reprocess('file-1');

    expect(fileRepo.updatePartial).toHaveBeenLastCalledWith(
      'file-1',
      expect.objectContaining({ processing_status: 'completed' }),
    );
  });

  it('completes non-prospectus files', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_name: 'notes.pdf', file_type: 'mom' }),
    );

    await service.reprocess('file-1');

    expect(fileRepo.updatePartial).toHaveBeenLastCalledWith(
      'file-1',
      expect.objectContaining({ processing_status: 'completed' }),
    );
  });

  it('never creates, merges or updates a company (pure refresh)', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_name: 'teaser.pdf', file_type: 'prospectus', origin_email: true } as never),
    );
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
      prospectus_summary: { company_name: 'Acme Corp' },
    } as never);

    await service.reprocess('file-1');

    expect(companyService.createFromDTO).not.toHaveBeenCalled();
    expect(companyService.updateFromDTO).not.toHaveBeenCalled();
    expect(companyFinancialRepo.bulkUpsertForCompany).not.toHaveBeenCalled();
  });

  it('marks the file as failed and rethrows when the agent throws', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_name: 'notes.pdf', file_type: 'mom' }),
    );
    vi.mocked(processFileContent).mockRejectedValue(new Error('AI error'));

    await expect(service.reprocess('file-1')).rejects.toThrow('AI error');
    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({ processing_status: 'failed' }),
    );
  });

  it('returns the refreshed record with a signed URL', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_link: 'uploads/report.pdf', file_name: 'report.pdf' }),
    );

    const result = await service.reprocess('file-1');

    expect(getSignedUrl).toHaveBeenCalledWith('uploads/report.pdf');
    expect(result).toMatchObject({ id: 'file-1', signed_url: 'https://signed-url' });
  });

  it('dispatches fund_update_extraction job when reprocessing an Excel fund_updates file', async () => {
    const mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ jobId: 'job-reprocess-123' }),
    };
    service.setJobDispatcher(mockDispatcher as any);

    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_name: 'report.xlsx', file_link: 'uploads/report.xlsx', file_type: 'fund_updates' }),
    );

    const result = await service.reprocess('file-1');

    expect(extractTextFromFile).not.toHaveBeenCalled();
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'fund_update_extraction',
        payload: expect.objectContaining({ fileId: 'file-1' }),
      }),
    );
    expect(result).toMatchObject({ jobId: 'job-reprocess-123' });
  });

  it('synchronously extracts via processFundUpdateContent when reprocessing a PDF fund_updates file without dispatching job', async () => {
    const mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ jobId: 'job-reprocess-123' }),
    };
    service.setJobDispatcher(mockDispatcher as any);

    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_name: 'report.pdf', file_link: 'uploads/report.pdf', file_type: 'fund_updates' }),
    );
    vi.mocked(processFundUpdateContent).mockResolvedValue({
      file_type: 'fund_updates',
      parser: 'llm_fallback',
      summary: 'PDF reprocessed summary',
      tags: ['Fund Update'],
      fund_update_proposal: null,
    } as any);

    const result = await service.reprocess('file-1');

    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
    expect(processFundUpdateContent).toHaveBeenCalled();
    expect((result as any).jobId).toBeUndefined();
  });

  it('marks file failed and throws when jobDispatcher is not set for async fund_updates Excel reprocess', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_name: 'report.xlsx', file_link: 'uploads/report.xlsx', file_type: 'fund_updates' }),
    );

    await expect(service.reprocess('file-1')).rejects.toThrow(
      'Failed to dispatch async fund update extraction job',
    );

    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({
        processing_status: 'failed',
        raw_notes: expect.stringContaining('Failed to dispatch async fund update extraction job'),
      }),
    );
  });

  it('marks file failed and throws when jobDispatcher.dispatch throws on async fund_updates Excel reprocess', async () => {
    const mockDispatcher = {
      dispatch: vi.fn().mockRejectedValue(new Error('Dispatcher down')),
    };
    service.setJobDispatcher(mockDispatcher as any);

    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_name: 'report.xlsx', file_link: 'uploads/report.xlsx', file_type: 'fund_updates' }),
    );

    await expect(service.reprocess('file-1')).rejects.toThrow(
      'Failed to dispatch async fund update extraction job',
    );

    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({
        processing_status: 'failed',
        raw_notes: expect.stringContaining('Failed to dispatch async fund update extraction job'),
      }),
    );
  });

  it('falls through to dispatch when JobRepository.findByTypeAndPayload throws during async reprocess', async () => {
    const { JobRepository } = await import('@/lib/repositories');
    const findSpy = vi.spyOn(JobRepository.prototype, 'findByTypeAndPayload').mockRejectedValueOnce(
      new Error('DB timeout'),
    );

    const mockDbClient = {} as DbClient;
    const customService = new FileService(
      mockDbClient,
      'workspace-1',
      fileRepo,
      makeCompanyAnalysisServiceStub(),
      makeAIScreeningServiceStub(),
      makeCriteriaRepoStub(),
      makeScreeningRepoStub(),
      companyFinancialRepo,
      companyService,
      makeCompanyFxAdjustmentRepoStub(),
      makeUserWorkspaceRepoStub(),
    );
    const mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ jobId: 'job-reprocess-dispatched' }),
    };
    customService.setJobDispatcher(mockDispatcher as any);

    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', file_name: 'report.xlsx', file_link: 'uploads/report.xlsx', file_type: 'fund_updates' }),
    );

    const result = await customService.reprocess('file-1');

    expect(mockDispatcher.dispatch).toHaveBeenCalled();
    expect(result).toMatchObject({ jobId: 'job-reprocess-dispatched' });
    findSpy.mockRestore();
  });
});

describe('FileService.processUpload — company_assigned emails', () => {
  let fileRepo: FileRepository;
  let companyService: CompanyService;
  let userRepo: { findByEmail: ReturnType<typeof vi.fn> };
  let enqueueEmail: ReturnType<typeof vi.fn>;
  let service: FileService;

  const custodian = {
    id: 'user-jane',
    name: 'Jane Doe',
    email: 'jane@corp.com',
  };

  beforeEach(() => {
    fileRepo = makeFileRepoStub();
    companyService = makeCompanyServiceStub();
    userRepo = { findByEmail: vi.fn().mockResolvedValue(custodian) };
    enqueueEmail = vi.fn().mockResolvedValue({ messageId: 'q-1' });
    service = new FileService(
      null as unknown as DbClient,
      'workspace-1',
      fileRepo,
      makeCompanyAnalysisServiceStub(),
      makeAIScreeningServiceStub(),
      makeCriteriaRepoStub(),
      makeScreeningRepoStub(),
      makeCompanyFinancialRepoStub(),
      companyService,
      makeCompanyFxAdjustmentRepoStub(),
      makeUserWorkspaceRepoStub(),
      undefined,
      userRepo as unknown as import('@/lib/repositories').UserRepository,
      enqueueEmail as never,
    );

    vi.mocked(downloadFile).mockResolvedValue(Buffer.from('content'));
    vi.mocked(getSignedUrl).mockResolvedValue('https://signed-url');
    vi.mocked(fileRepo.insert).mockResolvedValue(makeFile({ id: 'file-1', processing_status: 'processing' }));
    vi.mocked(fileRepo.findById).mockResolvedValue(makeFile({ id: 'file-1', processing_status: 'completed' }));
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
      prospectus_summary: { company_name: 'Acme Corp' },
    } as never);
    vi.mocked(companyService.findByNameFuzzy).mockResolvedValue(null as never);
    vi.mocked(companyService.createFromDTO).mockResolvedValue({
      id: 'company-new',
      target: 'Acme Corp',
    } as never);
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ id: 'company-new', target: 'Acme Corp' }),
    );
  });

  // (key, fileName, contentType, rawNotes, override, originEmail, bankerSource, enteredByEmail, uploaderUserId)
  const emailPipelineUpload = () =>
    service.processUpload(
      'uploads/teaser.pdf',
      'teaser.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
      'Goldman Sachs',
      'jane@corp.com',
      null,
    );

  it('enqueues a company_assigned email to the matched custodian for each created company', async () => {
    await emailPipelineUpload();

    expect(userRepo.findByEmail).toHaveBeenCalledWith('jane@corp.com');
    expect(companyService.createFromDTO).toHaveBeenCalledWith(
      expect.objectContaining({ entered_by: 'user-jane' }),
      'auto_created_from_file:file-1',
      { deferPendingArrival: true },
    );
    expect(enqueueEmail).toHaveBeenCalledTimes(1);
    expect(enqueueEmail).toHaveBeenCalledWith({
      kind: 'company_assigned',
      to: 'jane@corp.com',
      recipientName: 'Jane Doe',
      companyName: 'Acme Corp',
      bankerSource: 'Goldman Sachs',
      companyUrl: expect.stringContaining('/pipeline/company-new'),
    });
  });

  it('does not enqueue an email when the custodian email matches no user', async () => {
    userRepo.findByEmail.mockResolvedValue(null);

    await emailPipelineUpload();

    expect(companyService.createFromDTO).toHaveBeenCalledWith(
      expect.objectContaining({ entered_by: null }),
      'auto_created_from_file:file-1',
      { deferPendingArrival: true },
    );
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('does not enqueue an email for manual UI uploads (originEmail=false)', async () => {
    await service.processUpload(
      'uploads/teaser.pdf',
      'teaser.pdf',
      'application/pdf',
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      'uploader-uuid',
    );

    expect(companyService.createFromDTO).toHaveBeenCalledWith(
      expect.objectContaining({ entered_by: 'uploader-uuid' }),
      'auto_created_from_file:file-1',
      { deferPendingArrival: true },
    );
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('does not enqueue an email when the company matched an existing one (dedup skip)', async () => {
    vi.mocked(companyService.findByNameFuzzy).mockResolvedValue(
      makeCompany({ id: 'company-existing', target: 'Acme Corp' }) as never,
    );

    await emailPipelineUpload();

    expect(companyService.createFromDTO).not.toHaveBeenCalled();
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('completes file processing even when the email enqueue fails', async () => {
    enqueueEmail.mockRejectedValue(new Error('queue down'));

    await emailPipelineUpload();

    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({ processing_status: 'completed' }),
    );
  });
});

describe('FileService.addMatchedCompany / removeMatchedCompanyEntry', () => {
  let fileRepo: FileRepository;
  let companyService: CompanyService;
  let service: FileService;

  beforeEach(() => {
    fileRepo = makeFileRepoStub();
    companyService = makeCompanyServiceStub();
    service = makeService({ fileRepo, companyService });
  });

  it('prepends a pipeline company to matched_companies', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({
        id: 'file-1',
        matched_companies: [],
        processing_status: 'completed',
      }),
    );
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ id: 'company-2', target: 'Blue Harbor', project_name: 'Project Blue' }),
    );
    const updated = makeFile({
      id: 'file-1',
      matched_companies: [
        {
          id: 'company-2',
          target: 'Blue Harbor',
          name: 'Blue Harbor',
          type: 'company',
          similarity: 1,
        },
      ],
    });
    vi.mocked(fileRepo.update).mockResolvedValue(updated);

    const result = await service.addMatchedCompany('file-1', 'company-2');

    expect(fileRepo.update).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({
        matched_companies: [
          expect.objectContaining({
            id: 'company-2',
            name: 'Blue Harbor',
            type: 'company',
          }),
        ],
      }),
    );
    expect(result).toBe(updated);
  });

  it('is idempotent when the company is already matched', async () => {
    const existing = makeFile({
      id: 'file-1',
      matched_companies: [
        { id: 'company-1', name: 'Acme Corp', type: 'company', similarity: 1 },
      ],
    });
    vi.mocked(fileRepo.findById).mockResolvedValue(existing);
    vi.mocked(companyService.findById).mockResolvedValue(makeCompany({ id: 'company-1' }));

    const result = await service.addMatchedCompany('file-1', 'company-1');

    expect(fileRepo.update).not.toHaveBeenCalled();
    expect(result).toBe(existing);
  });

  it('removes a linked company by id', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({
        matched_companies: [
          { id: 'company-1', name: 'Acme', type: 'company' },
          { id: 'company-2', name: 'Beta', type: 'company' },
        ],
      }),
    );
    const updated = makeFile({
      matched_companies: [{ id: 'company-2', name: 'Beta', type: 'company' }],
    });
    vi.mocked(fileRepo.update).mockResolvedValue(updated);

    await service.removeMatchedCompanyEntry('file-1', { companyId: 'company-1' });

    expect(fileRepo.update).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({
        matched_companies: [
          expect.objectContaining({ id: 'company-2' }),
        ],
      }),
    );
  });

  it('removes an unmatched AI suggestion by name', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({
        matched_companies: [
          { id: null, name: 'Phantom Null Co', type: 'company' },
          { id: 'company-1', name: 'Acme', type: 'company' },
        ],
      }),
    );
    vi.mocked(fileRepo.update).mockResolvedValue(
      makeFile({
        matched_companies: [{ id: 'company-1', name: 'Acme', type: 'company' }],
      }),
    );

    await service.removeMatchedCompanyEntry('file-1', {
      unmatchedName: 'Phantom Null Co',
    });

    expect(fileRepo.update).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({
        matched_companies: [
          expect.objectContaining({ id: 'company-1' }),
        ],
      }),
    );
  });

  it('removes unmatched chips when name is whitespace but target is set', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({
        matched_companies: [
          { id: null, name: '   ', target: 'Acme From Target', type: 'company' },
        ],
      }),
    );
    vi.mocked(fileRepo.update).mockResolvedValue(makeFile({ matched_companies: [] }));

    await service.removeMatchedCompanyEntry('file-1', {
      unmatchedName: 'Acme From Target',
    });

    expect(fileRepo.update).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({ matched_companies: [] }),
    );
  });

  it('removes unmatched chips when name/target are whitespace-only', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({
        matched_companies: [{ id: null, name: '  ', target: '   ', type: 'company' }],
      }),
    );
    vi.mocked(fileRepo.update).mockResolvedValue(makeFile({ matched_companies: [] }));

    await service.removeMatchedCompanyEntry('file-1', { unmatchedName: 'Unnamed' });

    expect(fileRepo.update).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({ matched_companies: [] }),
    );
  });

  it('throws when company_id is missing for remove', async () => {
    await expect(
      service.removeMatchedCompanyEntry('file-1', {}),
    ).rejects.toThrow(/companyId or unmatchedName/);
  });
});

describe('MB-513 FileService Fund Update Review & Lifecycle Contract', () => {
  describe('proposal normalization across all shapes (Req 1)', () => {
    it('normalizes STARTECH quarterly proposal into unified FundUpdateReviewData with assets, funds, investors, sources', async () => {
      const fileRepo = makeFileRepoStub();
      const mockApplyService = {
        buildFullReview: vi.fn().mockResolvedValue({
          assets: [
            {
              code: 'ST-01',
              name: 'Startech Asset 1',
              fund: 'Startech Growth Fund 1',
              asset_type: 'direct_investment',
              entity: 'Startech LP',
              funding_source: 'DCA',
              status: 'new',
              matched_asset_id: null,
              proposed_txn_count: 1,
              proposed_valuation_count: 1,
              missing_txn_count: 1,
              missing_valuation_count: 1,
              proposed: {
                code: 'ST-01',
                name: 'Startech Asset 1',
                fund: 'Startech Growth Fund 1',
                entity: 'Startech LP',
                fundingSource: 'DCA',
                fundingSourceRaw: 'DCA',
                txns: [{ date: '2023-01-01', type: 'contribution', valueAmount: 100, currency: 'USD' }],
                valuations: [{ asOfDate: '2023-03-31', marketValue: 150, currency: 'USD' }],
              },
              missing_txns: [{ date: '2023-01-01', type: 'contribution', valueAmount: 100, currency: 'USD' }],
              missing_valuations: [{ asOfDate: '2023-03-31', marketValue: 150, currency: 'USD' }],
            },
          ],
          funds: [{ name: 'Startech Growth Fund 1', status: 'existing', matched_id: 'fund-1' }],
          investors: [{ name: 'Startech LP', status: 'new', matched_id: null }],
          sources: [{ name: 'DCA', status: 'existing', matched_id: 'fs-1' }],
          reconciliation: [],
          review_items: [],
        }),
      };

      const startechNotes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'startech_master_sheet_v1',
        summary: 'STARTECH Q1 2023 Update',
        fund_update_proposal: {
          template_id: 'startech_master_sheet_v1',
          stats: {
            asset_count: 1,
            direct_count: 1,
            fund_of_funds_count: 0,
            transaction_count: 1,
            valuation_count: 1,
          },
          assets: [
            {
              code: 'ST-01',
              name: 'Startech Asset 1',
              fund: 'Startech Growth Fund 1',
              entity: 'Startech LP',
              fundingSource: 'DCA',
              txns: [{ date: '2023-01-01', type: 'contribution', valueAmount: 100, currency: 'USD' }],
              valuations: [{ asOfDate: '2023-03-31', marketValue: 150, currency: 'USD' }],
            },
          ],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({ id: 'file-st', file_type: 'fund_updates', structured_notes: startechNotes }),
      );

      const service = makeService({ fileRepo });
      service.setFundUpdateApplyService(mockApplyService as any);

      const result = await service.getReviewData('file-st');

      expect(result.kind).toBe('fund_updates');
      if (result.kind !== 'fund_updates') throw new Error('Expected fund_updates');

      expect(result.template_id).toBe('startech_master_sheet_v1');
      expect(result.assets).toHaveLength(1);
      expect(result.assets[0].code).toBe('ST-01');
      expect(result.funds[0].name).toBe('Startech Growth Fund 1');
      expect(result.funds[0].asset_codes).toEqual(['ST-01']);
      expect(result.investors[0].name).toBe('Startech LP');
      expect(result.investors[0].asset_codes).toEqual(['ST-01']);
      expect(result.sources[0].name).toBe('DCA');
      expect(result.sources[0].asset_codes).toEqual(['ST-01']);
    });

    it('normalizes Nanjing lifecycle proposal into unified FundUpdateReviewData with commitment events and unresolved review items', async () => {
      const fileRepo = makeFileRepoStub();
      const mockApplyService = {
        buildFullReview: vi.fn().mockImplementation((_assets, _commitments, options) => ({
          assets: [
            {
              code: 'NJ-01',
              name: 'Nanjing Co',
              fund: '南京新工基金',
              asset_type: 'direct_investment',
              status: 'new',
              proposed: { code: 'NJ-01', name: 'Nanjing Co', fund: '南京新工基金', txns: [], valuations: [] },
              missing_txns: [],
              missing_valuations: [],
            },
          ],
          funds: [{ name: '南京新工基金', status: 'new', matched_id: null }],
          investors: [{ name: '南京国资', status: 'new', matched_id: null }],
          sources: [],
          reconciliation: options?.reconciliation ?? [],
          review_items: options?.review_items ?? [],
        })),
      };

      const nanjingNotes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'nanjing_fund_ledger_v1',
        summary: 'Nanjing Fund Ledger 2023',
        fund_update_proposal: {
          template_id: 'nanjing_fund_ledger_v1',
          stats: { asset_count: 1, commitment_event_count: 2 },
          assets: [{ code: 'NJ-01', name: 'Nanjing Co', fund: '南京新工基金', txns: [], valuations: [] }],
          fund_catalog: ['南京新工基金'],
          reconciliation: [
            {
              metricName: 'Paid-in Capital vs Summary',
              fund: '南京新工基金',
              sourceValue: 10_000_000,
              calculatedValue: 10_000_000,
              diff: 0,
              diffPct: 0,
              isReconciled: true,
            },
          ],
          review_items: [
            {
              sourceRow: 5,
              fund: '南京新工基金',
              investorName: '南京国资',
              date: '2023-05-10',
              amount: 200_000,
              currency: 'CNY',
              action: '实缴调整',
              nature: '损益核销',
              direction: '非现金调整',
              category: 'non_cash_adjustment',
              explanation: 'Non cash writeoff',
              isPostable: false,
              requiresReview: true,
            },
          ],
          commitment_events: [
            {
              fund: '南京新工基金',
              investorName: '南京国资',
              date: '2023-01-15',
              amount: 5_000_000,
              currency: 'CNY',
              intent: 'increase',
              actionRaw: '认缴',
              natureRaw: '新增额度',
              directionRaw: '认缴额度增加',
              sourceRow: 2,
            },
            {
              fund: '南京新工基金',
              investorName: '南京国资',
              date: '2023-06-01',
              amount: 1_000_000,
              currency: 'CNY',
              intent: 'transfer_in',
              counterpartyName: '未核实投资人',
              sourceRow: 10,
              transferPairing: {
                status: 'missing_counterparty',
                requiresReview: true,
                eligibleForTransferOut: false,
                reviewReason: 'Missing verified transferor counterparty',
              },
            },
          ],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({ id: 'file-nj', file_type: 'fund_updates', structured_notes: nanjingNotes }),
      );

      const service = makeService({ fileRepo });
      service.setFundUpdateApplyService(mockApplyService as any);

      const result = await service.getReviewData('file-nj');

      expect(result.kind).toBe('fund_updates');
      if (result.kind !== 'fund_updates') throw new Error('Expected fund_updates');

      expect(result.reconciliation).toHaveLength(1);
      expect(result.reconciliation[0].isReconciled).toBe(true);

      // 1 explicit review item (non-cash adjustment) + 1 unresolved transfer converted into review item
      expect(result.review_items).toHaveLength(2);
      expect(result.review_items.some((r) => r.category === 'non_cash_adjustment')).toBe(true);
      expect(result.review_items.some((r) => r.action === 'Commitment transfer')).toBe(true);
    });

    it('normalizes Workbook Fallback v1 proposal into unified FundUpdateReviewData with hydrated assets and linked catalog asset codes', async () => {
      const fileRepo = makeFileRepoStub();
      const mockApplyService = {
        buildFullReview: vi.fn().mockImplementation((assets) => ({
          assets: assets.map((a: any) => ({
            code: a.code,
            name: a.name,
            fund: a.fund,
            asset_type: a.assetType ?? 'direct_investment',
            entity: a.entity,
            funding_source: a.fundingSource,
            status: 'new',
            proposed: a,
            missing_txns: a.txns ?? [],
            missing_valuations: a.valuations ?? [],
          })),
          funds: [],
          investors: [],
          sources: [],
          reconciliation: [],
          review_items: [],
        })),
      };

      const fallbackNotes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'workbook_fallback_llm',
        summary: 'LLM Fallback Extraction',
        fund_update_proposal: {
          template_id: 'workbook_fallback_v1',
          schema_version: 'workbook_fallback_v1',
          stats: {
            asset_count: 1,
            direct_count: 1,
            fund_of_funds_count: 0,
            transaction_count: 1,
            valuation_count: 1,
            entity_count: 2,
            event_count: 1,
          },
          entities: [
            { proposalId: 'ent-fund-1', entityType: 'fund', originalName: 'Global Growth Fund', aliases: [], sourceLocations: [], warnings: [] },
            { proposalId: 'ent-inv-1', entityType: 'institutional_investor', originalName: 'Acme Holding LP', aliases: [], sourceLocations: [], warnings: [] },
            { proposalId: 'ent-target-1', entityType: 'portfolio_company', originalName: 'BioTech Innovations', aliases: [], sourceLocations: [], warnings: [] },
          ],
          events: [
            {
              proposalId: 'evt-1',
              eventType: 'asset_investment',
              fromEntityRef: 'ent-inv-1',
              toEntityRef: 'ent-target-1',
              relatedFundRef: 'Global Growth Fund',
              date: '2023-04-15',
              normalizedAmount: 2_000_000,
              normalizedCurrency: 'USD',
              sourceLocation: { sheet: 'Sheet1', row: 4 },
              warnings: [],
            },
          ],
          valuations: [
            {
              proposalId: 'val-1',
              entityRef: 'ent-target-1',
              asOfDate: '2023-06-30',
              normalizedMarketValue: 2_500_000,
              normalizedCurrency: 'USD',
              sourceLocation: { sheet: 'Sheet1', row: 5 },
              warnings: [],
            },
          ],
          assets: [
            {
              code: 'BIO-01',
              name: 'BioTech Innovations',
              fund: '', // Empty: will be hydrated from event relatedFundRef
              entity: '', // Empty: will be hydrated from event fromEntityRef
              fundingSource: null,
              txns: [{ date: '2023-04-15', type: 'contribution', valueAmount: 2_000_000, currency: 'USD' }],
              valuations: [{ asOfDate: '2023-06-30', marketValue: 2_500_000, currency: 'USD' }],
            },
          ],
          reconciliation: [],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({ id: 'file-v1-norm', file_type: 'fund_updates', structured_notes: fallbackNotes }),
      );

      const service = makeService({ fileRepo });
      service.setFundUpdateApplyService(mockApplyService as any);

      const result = await service.getReviewData('file-v1-norm');

      expect(result.kind).toBe('fund_updates');
      if (result.kind !== 'fund_updates') throw new Error('Expected fund_updates');

      // Check hydration: fund and entity populated from events
      expect(result.assets[0].proposed.fund).toBe('Global Growth Fund');
      expect(result.assets[0].proposed.entity).toBe('Acme Holding LP');

      // Extra fund and investor entities merged into catalogs
      expect(result.funds.some((f) => f.name === 'Global Growth Fund')).toBe(true);
      expect(result.investors.some((i) => i.name === 'Acme Holding LP')).toBe(true);
    });
  });

  describe('step 1 staging without writes (Req 2)', () => {
    it('stages fund_updates file in awaiting_review status without invoking ledger or master data writes during processUpload', async () => {
      const fileRepo = makeFileRepoStub();
      const companyService = makeCompanyServiceStub();
      const mockApplyService = {
        buildReview: vi.fn().mockResolvedValue([{ status: 'new' }]),
      };

      const fundUpdateResult = {
        file_type: 'fund_updates',
        parser: 'startech_master_sheet_v1',
        summary: 'Extracted Startech updates',
        key_points: [],
        action_items: [],
        tags: ['fund_updates'],
        companies_detected: [],
        company_notes: [],
        file_date: '2023-03-31',
        suggested_track_ids: [],
        matched_companies: [],
        fund_update_proposal: {
          template_id: 'startech_master_sheet_v1',
          stats: { asset_count: 1 },
          assets: [{ code: 'A1', name: 'Asset 1', txns: [], valuations: [] }],
        },
      };

      vi.mocked(processFundUpdateContent).mockResolvedValue(fundUpdateResult as any);
      vi.mocked(fileRepo.insert).mockResolvedValue(makeFile({ id: 'file-stage-1' }));
      vi.mocked(fileRepo.findById).mockResolvedValue(makeFile({ id: 'file-stage-1' }));

      const service = makeService({ fileRepo, companyService });
      service.setFundUpdateApplyService(mockApplyService as any);

      await service.processUpload(
        'uploads/startech_report.pdf',
        'startech_report.pdf',
        'application/pdf',
        undefined,
        'fund_updates',
        false,
      );

      // File was updated with awaiting_review processing status and structured notes
      expect(fileRepo.updatePartial).toHaveBeenCalledWith(
        'file-stage-1',
        expect.objectContaining({
          processing_status: 'awaiting_review',
          file_type: 'fund_updates',
          structured_notes: expect.stringContaining('startech_master_sheet_v1'),
        }),
      );

      // ZERO master data / company creation writes took place during step 1
      expect(companyService.createFromDTO).not.toHaveBeenCalled();
    });
  });

  describe('lifecycle processing status gates & approve forwarding (Req 10 & 5, 6, 8)', () => {
    it('does not fall back to posting every commitment event when the two-step row selection is empty', async () => {
      const fileRepo = makeFileRepoStub();
      const mockApplyService = {
        buildFullReview: vi.fn().mockResolvedValue({
          assets: [],
          funds: [],
          investors: [],
          sources: [],
          reconciliation: [],
          review_items: [],
        }),
        applySelected: vi.fn().mockResolvedValue({
          applied: 0,
          created_assets: 0,
          updated_assets: 0,
          skipped: 0,
          txns_inserted: 0,
          valuations_upserted: 0,
        }),
        applyCommitmentEvents: vi.fn(),
      };
      const notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'nanjing_fund_ledger_v1',
        fund_update_proposal: {
          template_id: 'nanjing_fund_ledger_v1',
          stats: { asset_count: 0, commitment_event_count: 1 },
          assets: [],
          commitment_events: [
            {
              fund: 'Fund A',
              fundEnglishName: 'Fund A English',
              investorName: 'Investor A',
              investorEnglishName: 'Investor A English',
              date: '2023-01-01',
              amount: 100,
              intent: 'increase',
              sourceRow: 2,
            },
          ],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({
          id: 'file-empty-two-step-selection',
          processing_status: 'awaiting_review',
          file_type: 'fund_updates',
          structured_notes: notes,
        }),
      );

      const service = makeService({ fileRepo });
      service.setFundUpdateApplyService(mockApplyService as any);

      const reviewData = await service.getReviewData('file-empty-two-step-selection');
      if (reviewData.kind !== 'fund_updates') throw new Error('Expected fund update review data');
      expect(
        reviewData.two_step_review.entities.find((entity) => entity.key === 'fund:Fund A')
          ?.englishName,
      ).toBe('Fund A English');
      expect(
        reviewData.two_step_review.entities.find(
          (entity) => entity.key === 'investor:Investor A',
        )?.englishName,
      ).toBe('Investor A English');

      await service.approve(
        'file-empty-two-step-selection',
        {
          file_type: 'fund_updates',
          matched_company_id: null,
          two_step_approval: {
            entityDecisions: [
              { key: 'fund:Fund A', action: 'omit' },
              { key: 'investor:Investor A', action: 'omit' },
            ],
            transactions: [],
            valuations: [],
          },
        },
        'reviewer@example.com',
      );

      expect(mockApplyService.applyCommitmentEvents).not.toHaveBeenCalled();
      expect(mockApplyService.applySelected).toHaveBeenCalledWith(
        [],
        [],
        [],
        expect.objectContaining({ fileId: 'file-empty-two-step-selection' }),
        { funds: [], investors: [], sources: [] },
      );
    });

    it('getReviewData exposes processing_status and approve transitions awaiting_review file to completed', async () => {
      const fileRepo = makeFileRepoStub();
      const mockApplyService = {
        buildFullReview: vi.fn().mockResolvedValue({
          assets: [],
          funds: [],
          investors: [],
          sources: [],
          reconciliation: [],
          review_items: [],
        }),
        applySelected: vi.fn().mockResolvedValue({
          applied: 1,
          created_assets: 1,
          updated_assets: 0,
          skipped: 0,
          txns_inserted: 1,
          valuations_upserted: 1,
        }),
        applyCommitmentEvents: vi.fn().mockResolvedValue({
          events_inserted: 1,
          events_skipped_duplicate: 0,
          events_skipped: 0,
          review_items_applied: 1,
          warnings: [],
        }),
      };

      const notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'nanjing_fund_ledger_v1',
        fund_update_proposal: {
          template_id: 'nanjing_fund_ledger_v1',
          stats: { asset_count: 1, commitment_event_count: 1 },
          assets: [{ code: 'NJ-01', name: 'Asset 1', txns: [], valuations: [] }],
          commitment_events: [
            { fund: 'Fund A', investorName: 'Investor A', date: '2023-01-01', amount: 100, intent: 'increase', sourceRow: 2 },
          ],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({ id: 'file-gate-1', processing_status: 'awaiting_review', file_type: 'fund_updates', structured_notes: notes }),
      );

      const service = makeService({ fileRepo });
      service.setFundUpdateApplyService(mockApplyService as any);

      // getReviewData returns processing_status
      const reviewData = await service.getReviewData('file-gate-1');
      expect(reviewData.file.processing_status).toBe('awaiting_review');

      // approve forwards selections, catalog selections, and resolutions to apply services
      const approveInput: ApproveFileInput = {
        file_type: 'fund_updates',
        matched_company_id: null,
        fund_update_asset_codes: ['NJ-01'],
        fund_update_selections: [
          {
            asset_code: 'NJ-01',
            txns: [
              {
                date: '2023-01-01',
                type: 'contribution',
                valueAmount: 100,
                currency: 'USD',
                subTypeLabel: null,
                pricePerShare: null,
                shareCount: null,
                fxRate: null,
                notes: null,
              },
            ],
          },
        ],
        fund_update_catalog_selections: {
          funds: ['Fund A'],
          investors: ['Investor A'],
          sources: [], // Optional source omitted/deselected
        },
        fund_update_review_resolutions: [
          {
            sourceRow: 5,
            resolutionType: 'non_cash_adjustment',
            investorName: 'Investor A',
            fundName: 'Fund A',
            date: '2023-05-01',
            amount: 50_000,
            currency: 'CNY',
            direction: 'reduction',
            subType: 'profit_loss_writeoff',
          },
        ],
      };

      const approveResult = await service.approve('file-gate-1', approveInput, 'reviewer@example.com');

      // Verify applySelected received catalog selections and selections
      expect(mockApplyService.applySelected).toHaveBeenCalledWith(
        expect.anything(),
        ['NJ-01'],
        approveInput.fund_update_selections,
        expect.objectContaining({ isV1: false, fileId: 'file-gate-1' }),
        approveInput.fund_update_catalog_selections,
      );

      // Verify applyCommitmentEvents received review resolutions and catalog selections
      expect(mockApplyService.applyCommitmentEvents).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          fileId: 'file-gate-1',
          createdBy: 'reviewer@example.com',
          catalogSelections: approveInput.fund_update_catalog_selections,
          reviewResolutions: approveInput.fund_update_review_resolutions,
        }),
      );

      // Verify file processing_status transitioned to completed
      expect(fileRepo.updatePartial).toHaveBeenCalledWith(
        'file-gate-1',
        expect.objectContaining({
          processing_status: 'completed',
        }),
        expect.anything(),
      );

      expect(approveResult.fund_update?.applied).toBe(1);
      expect(approveResult.fund_update?.commitment_events_inserted).toBe(1);
    });

    it('translates FoF decision under Fund tab into applySelected codes without duplicate asset decision', async () => {
      const fileRepo = makeFileRepoStub();
      const mockApplyService = {
        buildFullReview: vi.fn().mockImplementation(async (proposedAssets: any[]) => {
          return {
            assets: proposedAssets.map((p) => ({
              code: p.code,
              name: p.name,
              fund: p.fund,
              asset_type: p.assetType,
              status: 'new',
              matched_asset_id: null,
              proposed_txn_count: p.txns.length,
              proposed_valuation_count: p.valuations.length,
              missing_txn_count: p.txns.length,
              missing_valuation_count: p.valuations.length,
              proposed: p,
              missing_txns: p.txns,
              missing_valuations: p.valuations,
            })),
            funds: [
              { name: '南京瑞满基金', status: 'existing', matched_id: 'fund-rm-1' },
              { name: '南通越盛股权投资合伙企业（有限合伙）', status: 'new', matched_id: null, role: 'Fund of Funds' },
            ],
            investors: [],
            sources: [],
            reconciliation: [],
            review_items: [],
          };
        }),
        applySelected: vi.fn().mockResolvedValue({
          applied: 1,
          created_assets: 0,
          updated_assets: 0,
          created_funds: 1,
          skipped: 0,
          txns_inserted: 1,
          valuations_upserted: 0,
          outcomes: [
            {
              submittedId: 'txn:SAPE40:0:2024-01-15:contribution',
              family: 'transaction',
              disposition: 'posted',
            },
          ],
        }),
        applyCommitmentEvents: vi.fn().mockResolvedValue({
          events_inserted: 0,
          events_skipped_duplicate: 0,
          events_skipped: 0,
          review_items_applied: 0,
          warnings: [],
        }),
      };

      const fofAsset = {
        code: 'SAPE40',
        name: '南通越盛股权投资合伙企业（有限合伙）',
        englishName: 'Yuesheng Fund LP',
        assetType: 'fund_of_funds',
        fund: '南京瑞满基金',
        txns: [{ date: '2024-01-15', type: 'contribution', valueAmount: 10000000, currency: 'CNY' }],
        valuations: [],
      };

      const notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'nanjing_fund_ledger_v1',
        fund_update_proposal: {
          template_id: 'nanjing_fund_ledger_v1',
          stats: { asset_count: 1, direct_count: 0, fund_of_funds_count: 1 },
          assets: [fofAsset],
          fund_catalog: ['南京瑞满基金'],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({
          id: 'file-fof-two-step',
          processing_status: 'awaiting_review',
          file_type: 'fund_updates',
          structured_notes: notes,
        }),
      );

      const service = makeService({ fileRepo });
      service.setFundUpdateApplyService(mockApplyService as any);

      // Verify review data has only Fund entity for FoF target, NO asset entity
      const reviewData = await service.getReviewData('file-fof-two-step');
      if (reviewData.kind !== 'fund_updates') throw new Error('Expected fund update review data');
      expect(reviewData.two_step_review.entities.filter((e) => e.tab === 'asset')).toHaveLength(0);
      expect(reviewData.two_step_review.entities.find((e) => e.key === 'fund:南通越盛股权投资合伙企业（有限合伙）')).toBeDefined();

      // Approve with FoF Fund staged
      await service.approve(
        'file-fof-two-step',
        {
          file_type: 'fund_updates',
          matched_company_id: null,
          two_step_approval: {
            entityDecisions: [
              { key: 'fund:南京瑞满基金', action: 'use_existing', matchedId: 'fund-rm-1' },
              { key: 'fund:南通越盛股权投资合伙企业（有限合伙）', action: 'create' },
            ],
            transactions: [
              {
                id: 'txn:SAPE40:0:2024-01-15:contribution',
                edits: { date: '2024-01-15', amount: 10000000, currency: 'CNY', cashDelta: -10000000 },
              },
            ],
            valuations: [],
          },
        },
        'reviewer@example.com',
      );

      // Verify applySelected was called with code 'SAPE40' derived from Fund decision,
      // and catalogSelections.funds contains ONLY managed/owning funds ('南京瑞满基金'), excluding the pure FoF target
      expect(mockApplyService.applySelected).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ code: 'SAPE40' })]),
        ['SAPE40'],
        [expect.objectContaining({ asset_code: 'SAPE40' })],
        expect.objectContaining({ fileId: 'file-fof-two-step' }),
        { funds: ['南京瑞满基金'], investors: [], sources: [] },
        expect.anything(),
      );
    });

    it('keeps a managed fund in catalogSelections when the same workbook also holds it as a FoF target', async () => {
      // Nanjing chains managed funds: 桐德 -> 月升星繁 -> 江苏美克. 月升星繁 is simultaneously a
      // fund_of_funds target (held by 桐德) and the owning fund of a direct asset, and it is in the
      // fund catalog. Excluding it from catalogSelections.funds left `fundId` null in applySelected,
      // so every asset it holds aborted the approval with "unresolved position for holder".
      const fileRepo = makeFileRepoStub();
      const mockApplyService = {
        buildFullReview: vi.fn().mockImplementation(async (proposedAssets: any[]) => ({
          assets: proposedAssets.map((p) => ({
            code: p.code,
            name: p.name,
            fund: p.fund,
            asset_type: p.assetType,
            status: 'new',
            matched_asset_id: null,
            proposed_txn_count: p.txns.length,
            proposed_valuation_count: p.valuations.length,
            missing_txn_count: p.txns.length,
            missing_valuation_count: p.valuations.length,
            proposed: p,
            missing_txns: p.txns,
            missing_valuations: p.valuations,
          })),
          funds: [
            { name: '南京桐德股权投资合伙企业（有限合伙）', status: 'new', matched_id: null },
            { name: '南京月升星繁创业投资合伙企业（有限合伙）', status: 'new', matched_id: null, role: 'Fund of Funds' },
          ],
          investors: [],
          sources: [],
          reconciliation: [],
          review_items: [],
        })),
        applySelected: vi.fn().mockResolvedValue({
          applied: 2,
          created_assets: 1,
          updated_assets: 0,
          created_funds: 2,
          skipped: 0,
          txns_inserted: 2,
          valuations_upserted: 0,
          outcomes: [
            {
              submittedId: 'txn:NJ-YUESHENG:0:2026-04-14:contribution',
              family: 'transaction',
              disposition: 'posted',
            },
            {
              submittedId: 'txn:NJ-MEDOMICS:0:2024-09-29:contribution',
              family: 'transaction',
              disposition: 'posted',
            },
          ],
        }),
        applyCommitmentEvents: vi.fn().mockResolvedValue({
          events_inserted: 0,
          events_skipped_duplicate: 0,
          events_skipped: 0,
          review_items_applied: 0,
          warnings: [],
        }),
      };

      const fofAsset = {
        code: 'NJ-YUESHENG',
        name: '南京月升星繁创业投资合伙企业（有限合伙）',
        assetType: 'fund_of_funds',
        fund: '南京桐德股权投资合伙企业（有限合伙）',
        txns: [{ date: '2026-04-14', type: 'contribution', valueAmount: 59000000, currency: 'CNY' }],
        valuations: [],
      };
      const heldDirectAsset = {
        code: 'NJ-MEDOMICS',
        name: '江苏美克医学技术有限公司',
        assetType: 'direct_investment',
        fund: '南京月升星繁创业投资合伙企业（有限合伙）',
        txns: [{ date: '2024-09-29', type: 'contribution', valueAmount: 30000000, currency: 'CNY' }],
        valuations: [],
      };

      const notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'nanjing_fund_ledger_v1',
        fund_update_proposal: {
          template_id: 'nanjing_fund_ledger_v1',
          stats: { asset_count: 2, direct_count: 1, fund_of_funds_count: 1 },
          assets: [fofAsset, heldDirectAsset],
          fund_catalog: [
            '南京桐德股权投资合伙企业（有限合伙）',
            '南京月升星繁创业投资合伙企业（有限合伙）',
          ],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({
          id: 'file-fof-managed-chain',
          processing_status: 'awaiting_review',
          file_type: 'fund_updates',
          structured_notes: notes,
        }),
      );

      const service = makeService({ fileRepo });
      service.setFundUpdateApplyService(mockApplyService as any);

      await service.approve(
        'file-fof-managed-chain',
        {
          file_type: 'fund_updates',
          matched_company_id: null,
          two_step_approval: {
            entityDecisions: [
              { key: 'fund:南京桐德股权投资合伙企业（有限合伙）', action: 'create' },
              { key: 'fund:南京月升星繁创业投资合伙企业（有限合伙）', action: 'create' },
              { key: 'asset:NJ-MEDOMICS', action: 'create' },
            ],
            transactions: [
              {
                id: 'txn:NJ-YUESHENG:0:2026-04-14:contribution',
                edits: { date: '2026-04-14', amount: 59000000, currency: 'CNY', cashDelta: -59000000 },
              },
              {
                id: 'txn:NJ-MEDOMICS:0:2024-09-29:contribution',
                edits: { date: '2024-09-29', amount: 30000000, currency: 'CNY', cashDelta: -30000000 },
              },
            ],
            valuations: [],
          },
        },
        'reviewer@example.com',
      );

      const catalogArg = mockApplyService.applySelected.mock.calls[0][4] as {
        funds: string[];
        investors: string[];
        sources: string[];
      };
      expect(catalogArg.funds).toContain('南京月升星繁创业投资合伙企业（有限合伙）');
      expect(catalogArg.funds).toContain('南京桐德股权投资合伙企业（有限合伙）');
    });

    it('approves a managed LP 实缴 and the payer 投资 into a managed fund without creating a managed-fund investor (MB-569)', async () => {
      const YUESHENG = '南京月升星繁创业投资合伙企业（有限合伙）';
      const HUAIAN = '淮安熙和创业投资基金合伙企业（有限合伙）';
      const fileRepo = makeFileRepoStub();
      const mockApplyService = {
        buildFullReview: vi.fn().mockImplementation(async (proposedAssets: any[]) => ({
          assets: proposedAssets.map((p) => ({
            code: p.code,
            name: p.name,
            fund: p.fund,
            asset_type: p.assetType,
            target_kind: 'fund',
            status: 'new',
            matched_asset_id: null,
            proposed_txn_count: p.txns.length,
            proposed_valuation_count: p.valuations.length,
            missing_txn_count: p.txns.length,
            missing_valuation_count: p.valuations.length,
            proposed: p,
            missing_txns: p.txns,
            missing_valuations: p.valuations,
          })),
          funds: [
            { name: YUESHENG, status: 'new', matched_id: null },
            { name: HUAIAN, status: 'new', matched_id: null, role: 'Fund of Funds' },
          ],
          investors: [],
          sources: [],
          reconciliation: [],
          review_items: [],
          commitment_event_statuses: { 196: 'actionable' },
        })),
        applySelected: vi.fn().mockResolvedValue({
          applied: 0,
          created_assets: 0,
          updated_assets: 0,
          created_funds: 0,
          skipped: 1,
          txns_inserted: 0,
          valuations_upserted: 0,
          outcomes: [
            {
              submittedId: 'txn:NJ-YUE-HUA:0:2024-09-09:contribution',
              family: 'transaction',
              disposition: 'stale',
              reason: `Recorded from ${HUAIAN}'s paid-in rows; this row posts no ledger entry.`,
            },
          ],
        }),
        applyCommitmentEvents: vi.fn().mockResolvedValue({
          events_inserted: 1,
          events_skipped_duplicate: 0,
          events_skipped: 0,
          review_items_applied: 0,
          warnings: [],
          outcomes: [{ submittedId: 'commitment:196', family: 'commitment_event', disposition: 'posted' }],
        }),
      };

      const fofAsset = {
        code: 'NJ-YUE-HUA',
        name: HUAIAN,
        assetType: 'fund_of_funds',
        fund: YUESHENG,
        txns: [{ date: '2024-09-09', type: 'contribution', valueAmount: 29000000, currency: 'CNY' }],
        valuations: [],
      };
      const paidIn = {
        fund: HUAIAN,
        investorName: YUESHENG,
        // An English half on the LP name must not turn the managed fund into an investor.
        investorEnglishName: 'Nanjing Yuesheng Xingfan Venture Capital Partnership',
        investorTypeRaw: '机构投资人',
        investorTypeLabel: 'Institutional Investor',
        date: '2024-09-13',
        intent: 'paid_in',
        amount: 29000000,
        currency: 'CNY',
        counterpartyName: null,
        actionRaw: '实缴',
        natureRaw: '实缴出资',
        directionRaw: '资金流入基金',
        notes: null,
        sourceRow: 196,
      };
      const notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'nanjing_fund_ledger_v1',
        fund_update_proposal: {
          template_id: 'nanjing_fund_ledger_v1',
          stats: { asset_count: 1, direct_count: 0, fund_of_funds_count: 1, commitment_event_count: 1 },
          assets: [fofAsset],
          commitment_events: [paidIn],
          fund_catalog: [YUESHENG, HUAIAN],
        },
      });
      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({
          id: 'file-managed-cross-book',
          processing_status: 'awaiting_review',
          file_type: 'fund_updates',
          structured_notes: notes,
        }),
      );

      const service = makeService({ fileRepo });
      service.setFundUpdateApplyService(mockApplyService as any);

      const reviewData = await service.getReviewData('file-managed-cross-book');
      if (reviewData.kind !== 'fund_updates') throw new Error('Expected fund update review data');
      const review = reviewData.two_step_review;
      expect(review.entities.some((e) => e.tab === 'investor' && e.name === YUESHENG)).toBe(false);
      expect(review.transactions.find((t) => t.id === 'commitment:196')?.fromKey).toBe(`fund:${YUESHENG}`);
      expect(review.transactions.find((t) => t.assetCode === 'NJ-YUE-HUA')?.reviewNote).toContain(`Recorded from ${HUAIAN}'s paid-in rows`);

      const result = await service.approve(
        'file-managed-cross-book',
        {
          file_type: 'fund_updates',
          matched_company_id: null,
          two_step_approval: {
            entityDecisions: [
              { key: `fund:${YUESHENG}`, action: 'create' },
              { key: `fund:${HUAIAN}`, action: 'create' },
            ],
            transactions: [
              { id: 'txn:NJ-YUE-HUA:0:2024-09-09:contribution', edits: {} },
              { id: 'commitment:196', edits: {} },
            ],
            valuations: [],
          },
        },
        'reviewer@example.com',
      );

      const [appliedEvents, commitmentOptions] = mockApplyService.applyCommitmentEvents.mock.calls[0] as [
        Array<{ sourceRow: number }>,
        { catalogSelections: { investors: string[]; funds: string[] } },
      ];
      expect(appliedEvents.map((e) => e.sourceRow)).toEqual([196]);
      expect(commitmentOptions.catalogSelections.investors).not.toContain(YUESHENG);
      expect(commitmentOptions.catalogSelections.funds).toEqual(expect.arrayContaining([YUESHENG, HUAIAN]));
      // applySelected learns which receiving-fund rows post in this approval.
      expect(mockApplyService.applySelected.mock.calls[0][3]).toEqual(
        expect.objectContaining({ commitmentEvents: [expect.objectContaining({ sourceRow: 196 })] }),
      );
      const outcomes = (result as any).fund_update.outcomes as Array<{ submittedId: string; disposition: string }>;
      expect(outcomes.map((o) => o.submittedId)).toEqual([
        'txn:NJ-YUE-HUA:0:2024-09-09:contribution',
        'commitment:196',
      ]);
    });

    it('still creates a staged direct asset when its owning fund is omitted', async () => {
      const fileRepo = makeFileRepoStub();
      const mockApplyService = {
        buildFullReview: vi.fn().mockImplementation(async (proposedAssets: any[]) => ({
          assets: proposedAssets.map((p) => ({
            code: p.code,
            name: p.name,
            fund: p.fund,
            asset_type: p.assetType,
            status: 'new',
            matched_asset_id: null,
            proposed_txn_count: p.txns.length,
            proposed_valuation_count: p.valuations.length,
            missing_txn_count: p.txns.length,
            missing_valuation_count: p.valuations.length,
            proposed: p,
            missing_txns: p.txns,
            missing_valuations: p.valuations,
          })),
          funds: [{ name: '南京瑞满基金', status: 'new', matched_id: null }],
          investors: [],
          sources: [],
          reconciliation: [],
          review_items: [],
        })),
        applySelected: vi.fn().mockResolvedValue({
          applied: 1,
          created_assets: 1,
          updated_assets: 0,
          created_funds: 0,
          skipped: 0,
          txns_inserted: 0,
          valuations_upserted: 0,
        }),
        applyCommitmentEvents: vi.fn().mockResolvedValue({
          events_inserted: 0,
          events_skipped_duplicate: 0,
          events_skipped: 0,
          review_items_applied: 0,
          warnings: [],
        }),
      };

      const directAsset = {
        code: 'NJ-MEDOMICS',
        name: '江苏美克医学技术有限公司',
        assetType: 'direct_investment',
        fund: '南京瑞满基金',
        txns: [{ date: '2024-01-15', type: 'contribution', valueAmount: 1000000, currency: 'CNY' }],
        valuations: [],
      };

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({
          id: 'file-direct-orphan',
          processing_status: 'awaiting_review',
          file_type: 'fund_updates',
          structured_notes: JSON.stringify({
            file_type: 'fund_updates',
            parser: 'nanjing_fund_ledger_v1',
            fund_update_proposal: {
              template_id: 'nanjing_fund_ledger_v1',
              stats: { asset_count: 1, direct_count: 1, fund_of_funds_count: 0 },
              assets: [directAsset],
              fund_catalog: ['南京瑞满基金'],
            },
          }),
        }),
      );

      const service = makeService({ fileRepo });
      service.setFundUpdateApplyService(mockApplyService as any);

      await service.approve(
        'file-direct-orphan',
        {
          file_type: 'fund_updates',
          matched_company_id: null,
          two_step_approval: {
            entityDecisions: [
              { key: 'asset:NJ-MEDOMICS', action: 'create' },
              { key: 'fund:南京瑞满基金', action: 'omit' },
            ],
            transactions: [],
            valuations: [],
          },
        },
        'reviewer@example.com',
      );

      // fl_assets has no fund column: the asset is standalone master data and is
      // created even though its owning fund was deselected. Only the position is
      // lost, which applySelected skips because the fund resolves to null.
      expect(mockApplyService.applySelected).toHaveBeenCalledWith(
        expect.anything(),
        ['NJ-MEDOMICS'],
        [expect.objectContaining({ asset_code: 'NJ-MEDOMICS' })],
        expect.anything(),
        { funds: [], investors: [], sources: [] },
        expect.anything(),
      );
    });

    it('still creates a staged FoF target when its owning fund is omitted, minus the holding', async () => {
      const fileRepo = makeFileRepoStub();
      const mockApplyService = {
        buildFullReview: vi.fn().mockImplementation(async (proposedAssets: any[]) => ({
          assets: proposedAssets.map((p) => ({
            code: p.code,
            name: p.name,
            fund: p.fund,
            asset_type: p.assetType,
            status: 'new',
            matched_asset_id: null,
            proposed_txn_count: p.txns.length,
            proposed_valuation_count: p.valuations.length,
            missing_txn_count: p.txns.length,
            missing_valuation_count: p.valuations.length,
            proposed: p,
            missing_txns: p.txns,
            missing_valuations: p.valuations,
          })),
          funds: [
            { name: '南京瑞满基金', status: 'existing', matched_id: 'fund-rm-1' },
            { name: '南京瑞来基金', status: 'existing', matched_id: 'fund-rl-1' },
            { name: '南通越盛股权投资合伙企业（有限合伙）', status: 'new', matched_id: null, role: 'Fund of Funds' },
          ],
          investors: [],
          sources: [],
          reconciliation: [],
          review_items: [],
        })),
        applySelected: vi.fn().mockResolvedValue({
          applied: 1,
          created_assets: 0,
          updated_assets: 0,
          created_funds: 1,
          skipped: 0,
          txns_inserted: 1,
          valuations_upserted: 0,
          outcomes: [
            {
              submittedId: 'txn:FOF-H1:0:2024-01-15:contribution',
              family: 'transaction',
              disposition: 'posted',
            },
          ],
        }),
      };

      const fofHolding1 = {
        code: 'FOF-H1',
        name: '南通越盛股权投资合伙企业（有限合伙）',
        assetType: 'fund_of_funds',
        fund: '南京瑞满基金',
        txns: [{ date: '2024-01-15', type: 'contribution', valueAmount: 6000000, currency: 'CNY' }],
        valuations: [],
      };
      const fofHolding2 = {
        code: 'FOF-H2',
        name: '南通越盛股权投资合伙企业（有限合伙）',
        assetType: 'fund_of_funds',
        fund: '南京瑞来基金',
        txns: [{ date: '2024-02-15', type: 'contribution', valueAmount: 4000000, currency: 'CNY' }],
        valuations: [],
      };

      const notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'nanjing_fund_ledger_v1',
        fund_update_proposal: {
          template_id: 'nanjing_fund_ledger_v1',
          stats: { asset_count: 2, direct_count: 0, fund_of_funds_count: 2 },
          assets: [fofHolding1, fofHolding2],
          fund_catalog: ['南京瑞满基金', '南京瑞来基金'],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({
          id: 'file-fof-multi-holding',
          processing_status: 'awaiting_review',
          file_type: 'fund_updates',
          structured_notes: notes,
        }),
      );

      const service = makeService({ fileRepo });
      service.setFundUpdateApplyService(mockApplyService as any);

      // Approve with:
      // Ruiman: use_existing
      // Ruilai: omit (deselected!)
      // Target Yuesheng: create
      await service.approve(
        'file-fof-multi-holding',
        {
          file_type: 'fund_updates',
          matched_company_id: null,
          two_step_approval: {
            entityDecisions: [
              { key: 'fund:南京瑞满基金', action: 'use_existing', matchedId: 'fund-rm-1' },
              { key: 'fund:南京瑞来基金', action: 'omit' }, // Omitted!
              { key: 'fund:南通越盛股权投资合伙企业（有限合伙）', action: 'create' },
            ],
            transactions: [
              {
                id: 'txn:FOF-H1:0:2024-01-15:contribution',
                edits: { date: '2024-01-15', amount: 6000000, currency: 'CNY', cashDelta: -6000000 },
              },
            ],
            valuations: [],
          },
        },
        'reviewer@example.com',
      );

      // The staged target fund is created from either holding row — fl_funds has
      // no parent column. Omitting Ruilai drops it from catalogSelections, so
      // applySelected resolves no fundId for FOF-H2 and opens no position for it.
      expect(mockApplyService.applySelected).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining(['FOF-H1', 'FOF-H2']),
        expect.arrayContaining([expect.objectContaining({ asset_code: 'FOF-H1' })]),
        expect.anything(),
        { funds: ['南京瑞满基金'], investors: [], sources: [] },
        expect.anything(),
      );
    });

    it('passes remapped target ID to applySelected when FoF target is remapped to existing fund', async () => {
      const fileRepo = makeFileRepoStub();
      const mockApplyService = {
        buildFullReview: vi.fn().mockImplementation(async (proposedAssets: any[]) => ({
          assets: proposedAssets.map((p) => ({
            code: p.code,
            name: p.name,
            fund: p.fund,
            asset_type: p.assetType,
            status: 'new',
            matched_asset_id: null,
            proposed_txn_count: p.txns.length,
            proposed_valuation_count: p.valuations.length,
            missing_txn_count: p.txns.length,
            missing_valuation_count: p.valuations.length,
            proposed: p,
            missing_txns: p.txns,
            missing_valuations: p.valuations,
          })),
          funds: [{ name: '南京瑞满基金', status: 'existing', matched_id: 'fund-rm-1' }],
          investors: [],
          sources: [],
          reconciliation: [],
          review_items: [],
        })),
        applySelected: vi.fn().mockResolvedValue({
          applied: 1,
          created_assets: 0,
          updated_assets: 1,
          created_funds: 0,
          skipped: 0,
          txns_inserted: 1,
          valuations_upserted: 0,
          outcomes: [
            {
              submittedId: 'txn:SAPE40:0:2024-01-15:contribution',
              family: 'transaction',
              disposition: 'posted',
            },
          ],
        }),
      };

      const fofAsset = {
        code: 'SAPE40',
        name: '南通越盛股权投资合伙企业（有限合伙）',
        assetType: 'fund_of_funds',
        fund: '南京瑞满基金',
        txns: [{ date: '2024-01-15', type: 'contribution', valueAmount: 10000000, currency: 'CNY' }],
        valuations: [],
      };

      const notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'nanjing_fund_ledger_v1',
        fund_update_proposal: {
          template_id: 'nanjing_fund_ledger_v1',
          stats: { asset_count: 1, direct_count: 0, fund_of_funds_count: 1 },
          assets: [fofAsset],
          fund_catalog: ['南京瑞满基金'],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({
          id: 'file-fof-remap',
          processing_status: 'awaiting_review',
          file_type: 'fund_updates',
          structured_notes: notes,
        }),
      );

      const service = makeService({ fileRepo });
      service.setFundUpdateApplyService(mockApplyService as any);

      // Approve with FoF target remapped to existing fund 'fund-existing-yuesheng'
      await service.approve(
        'file-fof-remap',
        {
          file_type: 'fund_updates',
          matched_company_id: null,
          two_step_approval: {
            entityDecisions: [
              { key: 'fund:南京瑞满基金', action: 'use_existing', matchedId: 'fund-rm-1' },
              {
                key: 'fund:南通越盛股权投资合伙企业（有限合伙）',
                action: 'use_existing',
                matchedId: 'fund-existing-yuesheng',
                remappedName: '南通越盛存续基金',
              },
            ],
            transactions: [
              {
                id: 'txn:SAPE40:0:2024-01-15:contribution',
                edits: { date: '2024-01-15', amount: 10000000, currency: 'CNY', cashDelta: -10000000 },
              },
            ],
            valuations: [],
          },
        },
        'reviewer@example.com',
      );

      // Verify applySelected was called with matched_target_id and remapped_target_name
      expect(mockApplyService.applySelected).toHaveBeenCalledWith(
        expect.anything(),
        ['SAPE40'],
        [
          expect.objectContaining({
            asset_code: 'SAPE40',
            matched_target_id: 'fund-existing-yuesheng',
            remapped_target_name: '南通越盛存续基金',
          }),
        ],
        expect.anything(),
        { funds: ['南京瑞满基金'], investors: [], sources: [] },
        expect.anything(),
      );
    });

    it('stages all constituent asset codes for canonical direct assets and passes decisions to applySelected', async () => {
      const fileRepo = makeFileRepoStub();
      const mockApplyService = {
        buildFullReview: vi.fn().mockImplementation((assets: any[]) => ({
          assets: assets.map((a) => ({
            code: a.code,
            name: a.name,
            asset_type: 'direct_investment',
            fund: a.fund,
            status: 'new',
            matched_asset_id: null,
            proposed_txn_count: a.txns?.length ?? 0,
            proposed_valuation_count: a.valuations?.length ?? 0,
            missing_txn_count: a.txns?.length ?? 0,
            missing_valuation_count: a.valuations?.length ?? 0,
            missing_txns: a.txns ?? [],
            missing_valuations: a.valuations ?? [],
            proposed: a,
          })),
          funds: [
            { name: '南京瑞满', status: 'new', matched_id: null },
            { name: '南京瑞来', status: 'new', matched_id: null },
          ],
          investors: [],
          sources: [],
          reconciliation: [],
          review_items: [],
        })),
        applySelected: vi.fn().mockResolvedValue({
          applied: 2,
          created_assets: 1,
          updated_assets: 1,
          created_funds: 2,
          skipped: 0,
          txns_inserted: 2,
          valuations_upserted: 0,
          outcomes: [
            {
              submittedId: 'txn:NJ-RM-SDT:0:2024-01-15:contribution',
              family: 'transaction',
              disposition: 'posted',
            },
            {
              submittedId: 'txn:NJ-RL-SDT:0:2024-02-01:contribution',
              family: 'transaction',
              disposition: 'posted',
            },
          ],
        }),
      };

      const assetRuiman = {
        code: 'NJ-RM-SDT',
        name: '赛德特生物制药有限公司',
        assetType: 'direct_investment',
        fund: '南京瑞满',
        txns: [{ date: '2024-01-15', type: 'contribution', valueAmount: 10000000, currency: 'CNY' }],
        valuations: [],
      };
      const assetRuilai = {
        code: 'NJ-RL-SDT',
        name: '赛德特生物制药有限公司 Saidet Biotech Co., Ltd.',
        assetType: 'direct_investment',
        fund: '南京瑞来',
        txns: [{ date: '2024-02-01', type: 'contribution', valueAmount: 5000000, currency: 'CNY' }],
        valuations: [],
      };

      const notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'nanjing_fund_ledger_v1',
        fund_update_proposal: {
          template_id: 'nanjing_fund_ledger_v1',
          stats: { asset_count: 2, direct_count: 2, fund_of_funds_count: 0 },
          assets: [assetRuiman, assetRuilai],
          fund_catalog: ['南京瑞满', '南京瑞来'],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({
          id: 'file-saidet-dedup',
          processing_status: 'awaiting_review',
          file_type: 'fund_updates',
          structured_notes: notes,
        }),
      );

      const service = makeService({ fileRepo });
      service.setFundUpdateApplyService(mockApplyService as any);

      // Approve with canonical asset matched to 'ast-saidet-existing'
      await service.approve(
        'file-saidet-dedup',
        {
          file_type: 'fund_updates',
          matched_company_id: null,
          two_step_approval: {
            entityDecisions: [
              { key: 'fund:南京瑞满', action: 'create' },
              { key: 'fund:南京瑞来', action: 'create' },
              {
                key: 'asset:NJ-RM-SDT',
                action: 'use_existing',
                matchedId: 'ast-saidet-existing',
              },
            ],
            transactions: [
              {
                id: 'txn:NJ-RM-SDT:0:2024-01-15:contribution',
                edits: { date: '2024-01-15', amount: 10000000, currency: 'CNY', cashDelta: -10000000 },
              },
              {
                id: 'txn:NJ-RL-SDT:0:2024-02-01:contribution',
                edits: { date: '2024-02-01', amount: 5000000, currency: 'CNY', cashDelta: -5000000 },
              },
            ],
            valuations: [],
          },
        },
        'reviewer@example.com',
      );

      // Verify both constituent asset codes were staged and received the canonical matchedId
      expect(mockApplyService.applySelected).toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining(['NJ-RM-SDT', 'NJ-RL-SDT']),
        expect.arrayContaining([
          expect.objectContaining({
            asset_code: 'NJ-RM-SDT',
            matched_target_id: 'ast-saidet-existing',
          }),
          expect.objectContaining({
            asset_code: 'NJ-RL-SDT',
            matched_target_id: 'ast-saidet-existing',
          }),
        ]),
        expect.anything(),
        expect.objectContaining({ funds: expect.arrayContaining(['南京瑞满', '南京瑞来']) }),
        expect.anything(),
      );
    });

    it('pre-approval safety invariant: rejects approval when two direct assets sharing canonical identity have conflicting decisions', async () => {
      const fileRepo = makeFileRepoStub();
      const mockApplyService = {
        buildFullReview: vi.fn().mockImplementation((assets: any[]) => ({
          assets: assets.map((a) => ({
            code: a.code,
            name: a.name,
            asset_type: 'direct_investment',
            fund: a.fund,
            status: 'new',
            matched_asset_id: null,
            proposed_txn_count: 0,
            proposed_valuation_count: 0,
            missing_txn_count: 0,
            missing_valuation_count: 0,
            missing_txns: [],
            missing_valuations: [],
            proposed: a,
          })),
          funds: [{ name: '南京瑞满', status: 'new', matched_id: null }, { name: '南京瑞来', status: 'new', matched_id: null }],
          investors: [],
          sources: [],
          reconciliation: [],
          review_items: [],
        })),
        applySelected: vi.fn(),
      };

      const assetRuiman = {
        code: 'NJ-RM-SDT',
        name: '赛德特生物制药有限公司',
        assetType: 'direct_investment',
        fund: '南京瑞满',
        txns: [],
        valuations: [],
      };
      const assetRuilai = {
        code: 'NJ-RL-SDT',
        name: '赛德特生物制药有限公司',
        assetType: 'direct_investment',
        fund: '南京瑞来',
        txns: [],
        valuations: [],
      };

      const notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'nanjing_fund_ledger_v1',
        fund_update_proposal: {
          template_id: 'nanjing_fund_ledger_v1',
          stats: { asset_count: 2, direct_count: 2, fund_of_funds_count: 0 },
          assets: [assetRuiman, assetRuilai],
          fund_catalog: ['南京瑞满', '南京瑞来'],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({
          id: 'file-saidet-conflict',
          processing_status: 'awaiting_review',
          file_type: 'fund_updates',
          structured_notes: notes,
        }),
      );

      const service = makeService({ fileRepo });
      service.setFundUpdateApplyService(mockApplyService as any);

      // Attempt approval with conflicting matchedIds for the same canonical entity
      await expect(
        service.approve(
          'file-saidet-conflict',
          {
            file_type: 'fund_updates',
            matched_company_id: null,
            two_step_approval: {
              entityDecisions: [
                { key: 'fund:南京瑞满', action: 'create' },
                { key: 'fund:南京瑞来', action: 'create' },
                { key: 'asset:NJ-RM-SDT', action: 'use_existing', matchedId: 'ast-saidet-1' },
                { key: 'asset:NJ-RL-SDT', action: 'use_existing', matchedId: 'ast-saidet-2' },
              ],
              transactions: [],
              valuations: [],
            },
          },
          'reviewer@example.com',
        ),
      ).rejects.toThrow(/Pre-approval safety invariant violation/);
    });

    it('pre-approval safety invariant: rejects asymmetric create vs use-existing decisions for the same canonical entity', async () => {
      const fileRepo = makeFileRepoStub();
      const mockApplyService = {
        buildFullReview: vi.fn().mockImplementation((assets: any[]) => ({
          assets: assets.map((a) => ({
            code: a.code,
            name: a.name,
            asset_type: 'direct_investment',
            fund: a.fund,
            status: 'new',
            matched_asset_id: null,
            proposed_txn_count: 0,
            proposed_valuation_count: 0,
            missing_txn_count: 0,
            missing_valuation_count: 0,
            missing_txns: [],
            missing_valuations: [],
            proposed: a,
          })),
          funds: [{ name: '南京瑞满', status: 'new', matched_id: null }, { name: '南京瑞来', status: 'new', matched_id: null }],
          investors: [],
          sources: [],
          reconciliation: [],
          review_items: [],
        })),
        applySelected: vi.fn().mockResolvedValue({
          created_assets: 1,
          updated_assets: 0,
          created_positions: 2,
          created_events: 2,
          created_valuations: 0,
          skipped_txns: 0,
          skipped_valuations: 0,
        }),
      };

      const notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'nanjing_fund_ledger_v1',
        fund_update_proposal: {
          template_id: 'nanjing_fund_ledger_v1',
          stats: { asset_count: 2, direct_count: 2, fund_of_funds_count: 0 },
          assets: [
            {
              code: 'NJ-RM-SDT',
              name: '赛德特生物制药有限公司',
              fund: '南京瑞满',
              assetType: 'direct_investment',
              txns: [],
              valuations: [],
            },
            {
              code: 'NJ-RL-SDT',
              name: '赛德特生物制药有限公司 Saidet Biotech',
              fund: '南京瑞来',
              assetType: 'direct_investment',
              txns: [],
              valuations: [],
            },
          ],
          fund_catalog: ['南京瑞满', '南京瑞来'],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({
          id: 'file-saidet-asym',
          processing_status: 'awaiting_review',
          file_type: 'fund_updates',
          structured_notes: notes,
        }),
      );

      const service = makeService({ fileRepo });
      service.setFundUpdateApplyService(mockApplyService as any);

      // One constituent is marked 'create' while the other is marked 'use_existing'
      await expect(
        service.approve(
          'file-saidet-asym',
          {
            file_type: 'fund_updates',
            matched_company_id: null,
            two_step_approval: {
              entityDecisions: [
                { key: 'fund:南京瑞满', action: 'create' },
                { key: 'fund:南京瑞来', action: 'create' },
                { key: 'asset:NJ-RM-SDT', action: 'create' },
                { key: 'asset:NJ-RL-SDT', action: 'use_existing', matchedId: 'ast-saidet-1' },
              ],
              transactions: [],
              valuations: [],
            },
          },
          'reviewer@example.com',
        ),
      ).rejects.toThrow(/conflicting action decisions/);
    });

    it('pre-approval safety invariant: rejects inconsistent remapped target names for the same canonical entity', async () => {
      const fileRepo = makeFileRepoStub();
      const mockApplyService = {
        buildFullReview: vi.fn().mockImplementation((assets: any[]) => ({
          assets: assets.map((a) => ({
            code: a.code,
            name: a.name,
            asset_type: 'direct_investment',
            fund: a.fund,
            status: 'new',
            matched_asset_id: null,
            proposed_txn_count: 0,
            proposed_valuation_count: 0,
            missing_txn_count: 0,
            missing_valuation_count: 0,
            missing_txns: [],
            missing_valuations: [],
            proposed: a,
          })),
          funds: [{ name: '南京瑞满', status: 'new', matched_id: null }, { name: '南京瑞来', status: 'new', matched_id: null }],
          investors: [],
          sources: [],
          reconciliation: [],
          review_items: [],
        })),
        applySelected: vi.fn(),
      };

      const notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'nanjing_fund_ledger_v1',
        fund_update_proposal: {
          template_id: 'nanjing_fund_ledger_v1',
          stats: { asset_count: 2, direct_count: 2, fund_of_funds_count: 0 },
          assets: [
            {
              code: 'NJ-RM-SDT',
              name: '赛德特生物制药有限公司',
              fund: '南京瑞满',
              assetType: 'direct_investment',
              txns: [],
              valuations: [],
            },
            {
              code: 'NJ-RL-SDT',
              name: '赛德特生物制药有限公司',
              fund: '南京瑞来',
              assetType: 'direct_investment',
              txns: [],
              valuations: [],
            },
          ],
          fund_catalog: ['南京瑞满', '南京瑞来'],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({
          id: 'file-saidet-remap',
          processing_status: 'awaiting_review',
          file_type: 'fund_updates',
          structured_notes: notes,
        }),
      );

      const service = makeService({ fileRepo });
      service.setFundUpdateApplyService(mockApplyService as any);

      await expect(
        service.approve(
          'file-saidet-remap',
          {
            file_type: 'fund_updates',
            matched_company_id: null,
            two_step_approval: {
              entityDecisions: [
                { key: 'fund:南京瑞满', action: 'create' },
                { key: 'fund:南京瑞来', action: 'create' },
                { key: 'asset:NJ-RM-SDT', action: 'create', remappedName: 'Target A' },
                { key: 'asset:NJ-RL-SDT', action: 'create', remappedName: 'Target B' },
              ],
              transactions: [],
              valuations: [],
            },
          },
          'reviewer@example.com',
        ),
      ).rejects.toThrow(/inconsistent target names/);
    });

    it('integration regression: rejects unresolved/create conflicts, and explicit use_existing resolution succeeds fanning out to chosen ID', async () => {
      const fileRepo = makeFileRepoStub();
      const mockApplyService = {
        buildFullReview: vi.fn().mockImplementation((assets: any[]) => ({
          assets: assets.map((a) => ({
            code: a.code,
            name: a.name,
            asset_type: 'direct_investment',
            fund: a.fund,
            status: a.matched_asset_id ? 'unchanged' : 'new',
            matched_asset_id: a.matched_asset_id ?? null,
            proposed_txn_count: 0,
            proposed_valuation_count: 0,
            missing_txn_count: 0,
            missing_valuation_count: 0,
            missing_txns: [],
            missing_valuations: [],
            proposed: a,
          })),
          funds: [
            { name: '南京瑞满', status: 'new', matched_id: null },
            { name: '南京瑞来', status: 'new', matched_id: null },
          ],
          investors: [],
          sources: [],
          reconciliation: [],
          review_items: [],
        })),
        applySelected: vi.fn().mockResolvedValue({
          created_assets: 0,
          updated_assets: 2,
          created_positions: 2,
          created_events: 0,
          created_valuations: 0,
          skipped_txns: 0,
          skipped_valuations: 0,
        }),
      };

      const notes = JSON.stringify({
        file_type: 'fund_updates',
        parser: 'nanjing_fund_ledger_v1',
        fund_update_proposal: {
          template_id: 'nanjing_fund_ledger_v1',
          stats: { asset_count: 2, direct_count: 2, fund_of_funds_count: 0 },
          assets: [
            {
              code: 'NJ-RM-SDT',
              name: '赛德特生物制药有限公司',
              fund: '南京瑞满',
              assetType: 'direct_investment',
              matched_asset_id: 'ast-saidet-1',
              txns: [],
              valuations: [],
            },
            {
              code: 'NJ-RL-SDT',
              name: '赛德特生物制药有限公司',
              fund: '南京瑞来',
              assetType: 'direct_investment',
              matched_asset_id: 'ast-saidet-2',
              txns: [],
              valuations: [],
            },
          ],
          fund_catalog: ['南京瑞满', '南京瑞来'],
        },
      });

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({
          id: 'file-saidet-conflict-integration',
          processing_status: 'awaiting_review',
          file_type: 'fund_updates',
          structured_notes: notes,
        }),
      );

      const service = makeService({ fileRepo });
      service.setFundUpdateApplyService(mockApplyService as any);

      // 1. Unresolved conflict (no entity decision or default staging) -> rejected
      await expect(
        service.approve(
          'file-saidet-conflict-integration',
          {
            file_type: 'fund_updates',
            matched_company_id: null,
            two_step_approval: {
              entityDecisions: [
                { key: 'fund:南京瑞满', action: 'create' },
                { key: 'fund:南京瑞来', action: 'create' },
              ],
              transactions: [],
              valuations: [],
            },
          },
          'reviewer@example.com',
        ),
      ).rejects.toThrow(/conflicting matched IDs/);

      // 2. Action: 'create' does not bypass the conflict -> rejected
      await expect(
        service.approve(
          'file-saidet-conflict-integration',
          {
            file_type: 'fund_updates',
            matched_company_id: null,
            two_step_approval: {
              entityDecisions: [
                { key: 'fund:南京瑞满', action: 'create' },
                { key: 'fund:南京瑞来', action: 'create' },
                { key: 'asset:NJ-RM-SDT', action: 'create' },
              ],
              transactions: [],
              valuations: [],
            },
          },
          'reviewer@example.com',
        ),
      ).rejects.toThrow(/conflicting matched IDs/);

      // 3. Action: 'use_existing' with explicit chosen matchedId: 'ast-saidet-1' -> succeeds!
      const result = await service.approve(
        'file-saidet-conflict-integration',
        {
          file_type: 'fund_updates',
          matched_company_id: null,
          two_step_approval: {
            entityDecisions: [
              { key: 'fund:南京瑞满', action: 'create' },
              { key: 'fund:南京瑞来', action: 'create' },
              { key: 'asset:NJ-RM-SDT', action: 'use_existing', matchedId: 'ast-saidet-1' },
            ],
            transactions: [],
            valuations: [],
          },
        },
        'reviewer@example.com',
      );

      expect(result).toBeDefined();
      expect(mockApplyService.applySelected).toHaveBeenCalledTimes(1);

      // Verify all constituent asset codes fan out to the single chosen matchedId
      const passedSelections = mockApplyService.applySelected.mock.calls[0][2];
      expect(passedSelections).toHaveLength(2);
      expect(passedSelections.find((s: any) => s.asset_code === 'NJ-RM-SDT')?.matched_target_id).toBe('ast-saidet-1');
      expect(passedSelections.find((s: any) => s.asset_code === 'NJ-RL-SDT')?.matched_target_id).toBe('ast-saidet-1');
    });

    it('threads reviewer sellProceedsDestination edit into applySelected and leaves unmarked sales without a destination', async () => {
      const fileRepo = makeFileRepoStub();
      const mockApplyService = {
        buildFullReview: vi.fn().mockImplementation(async (proposedAssets: any[]) => ({
          assets: proposedAssets.map((p) => ({
            code: p.code,
            name: p.name,
            fund: p.fund,
            asset_type: p.assetType,
            status: 'new',
            matched_asset_id: null,
            proposed_txn_count: p.txns.length,
            proposed_valuation_count: p.valuations.length,
            missing_txn_count: p.txns.length,
            missing_valuation_count: p.valuations.length,
            proposed: p,
            missing_txns: p.txns,
            missing_valuations: p.valuations,
          })),
          funds: [{ name: 'Fund A', status: 'new', matched_id: null }],
          investors: [{ name: 'Investor A', status: 'new', matched_id: null }],
          sources: [],
          reconciliation: [],
          review_items: [],
        })),
        applySelected: vi.fn().mockImplementation(async () => ({
          applied: 1,
          created_assets: 1,
          updated_assets: 0,
          created_funds: 0,
          skipped: 0,
          txns_inserted: 2,
          valuations_upserted: 0,
          outcomes: [
            {
              submittedId: 'txn:AST-SELL:0:2024-06-01:divestment',
              family: 'transaction',
              disposition: 'posted',
            },
            {
              submittedId: 'txn:AST-SELL:1:2024-07-01:divestment',
              family: 'transaction',
              disposition: 'posted',
            },
          ],
        })),
        applyCommitmentEvents: vi.fn().mockResolvedValue({
          events_inserted: 0,
          events_skipped_duplicate: 0,
          events_skipped: 0,
          review_items_applied: 0,
          warnings: [],
        }),
      };

      const statedSell = {
        date: '2024-06-01',
        type: 'divestment',
        subTypeLabel: null,
        pricePerShare: 10,
        shareCount: 5,
        valueAmount: 50,
        currency: 'USD',
        fxRate: null,
        notes: null,
        sellProceedsDestination: null,
      };
      const unmarkedSell = {
        date: '2024-07-01',
        type: 'divestment',
        subTypeLabel: null,
        pricePerShare: 10,
        shareCount: 2,
        valueAmount: 20,
        currency: 'USD',
        fxRate: null,
        notes: null,
        sellProceedsDestination: null,
      };
      const asset = {
        code: 'AST-SELL',
        name: 'Sell Co',
        assetType: 'direct_investment',
        fund: 'Fund A',
        entity: 'Investor A',
        holderKind: 'investor',
        txns: [statedSell, unmarkedSell],
        valuations: [],
      };

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({
          id: 'file-sell-dest-edit',
          processing_status: 'awaiting_review',
          file_type: 'fund_updates',
          structured_notes: JSON.stringify({
            file_type: 'fund_updates',
            parser: 'startech_quarterly_v1',
            fund_update_proposal: {
              template_id: 'startech_quarterly_v1',
              stats: { asset_count: 1, direct_count: 1, fund_of_funds_count: 0 },
              assets: [asset],
              fund_catalog: ['Fund A'],
            },
          }),
        }),
      );

      const service = makeService({ fileRepo });
      service.setFundUpdateApplyService(mockApplyService as any);

      const reviewData = await service.getReviewData('file-sell-dest-edit');
      if (reviewData.kind !== 'fund_updates') throw new Error('Expected fund update review');
      const sellRows = reviewData.two_step_review.transactions.filter((t) => t.type === 'sell');
      expect(sellRows).toHaveLength(2);
      // Unmarked → no stated destination; the UI renders the effective default
      expect(sellRows.every((t) => t.sellProceedsDestination == null)).toBe(true);
      expect(sellRows.every((t) => (t.cashDelta ?? 0) > 0)).toBe(true);

      const [editRow, leaveInferredRow] = sellRows;

      await service.approve(
        'file-sell-dest-edit',
        {
          file_type: 'fund_updates',
          matched_company_id: null,
          two_step_approval: {
            entityDecisions: [
              { key: 'asset:AST-SELL', action: 'create' },
              { key: 'fund:Fund A', action: 'create' },
              { key: 'investor:Investor A', action: 'create' },
            ],
            transactions: [
              {
                id: editRow.id,
                edits: {
                  date: editRow.date,
                  cashDelta: editRow.cashDelta,
                  sellProceedsDestination: 'cash_in_fund',
                },
              },
              {
                id: leaveInferredRow.id,
                edits: {
                  date: leaveInferredRow.date,
                  cashDelta: leaveInferredRow.cashDelta,
                  // no sellProceedsDestination — keep inferred on apply
                },
              },
            ],
            valuations: [],
          },
        },
        'reviewer@example.com',
      );

      expect(mockApplyService.applySelected).toHaveBeenCalled();
      const selections = mockApplyService.applySelected.mock.calls[0][2];
      const postedTxns = selections[0].txns;
      const edited = postedTxns.find((t: any) => t.submittedId === editRow.id);
      const unmarked = postedTxns.find((t: any) => t.submittedId === leaveInferredRow.id);
      expect(edited?.sellProceedsDestination).toBe('cash_in_fund');
      expect(unmarked?.sellProceedsDestination).toBeNull();
    });
  });

  describe('FileService.approve (fund_updates hardening)', () => {
    const makeHarness = (applySelectedOutcomes: any[] = []) => {
      const mockDb = makeMockDb();
      const fileRepo = makeFileRepoStub();
      const mockApplyService = {
        buildFullReview: vi.fn().mockImplementation(async (proposedAssets: any[]) => ({
          assets: proposedAssets.map((p) => ({
            code: p.code,
            name: p.name,
            fund: p.fund,
            asset_type: p.assetType,
            status: 'new',
            matched_asset_id: null,
            proposed_txn_count: (p.txns ?? []).length,
            proposed_valuation_count: (p.valuations ?? []).length,
            missing_txn_count: (p.txns ?? []).length,
            missing_valuation_count: (p.valuations ?? []).length,
            proposed: p,
            missing_txns: p.txns ?? [],
            missing_valuations: p.valuations ?? [],
          })),
          funds: [
            { name: 'Fund A', status: 'new', matched_id: null },
            ...proposedAssets.filter((p) => p.fund && p.holderKind !== 'investor').map((p) => ({ name: p.fund, status: 'new', matched_id: null })),
          ],
          groups: proposedAssets
            .filter((p) => p.group || (p.holderKind === 'investor' && p.fund))
            .map((p) => ({ name: p.group || p.fund, status: 'new', matched_id: null })),
          investors: proposedAssets
            .filter((p) => p.entity || p.holderName)
            .map((p) => ({ name: p.entity || p.holderName, status: 'new', matched_id: null })),
          sources: proposedAssets
            .filter((p) => p.fundingSource)
            .map((p) => ({ name: p.fundingSource, status: 'new', matched_id: null })),
          reconciliation: [],
          review_items: [],
        })),
        applySelected: vi.fn().mockResolvedValue({
          applied: 1,
          created_assets: 1,
          updated_assets: 0,
          created_funds: 0,
          skipped: 0,
          txns_inserted: 1,
          valuations_upserted: 0,
          outcomes: applySelectedOutcomes,
        }),
      };
      const service = makeService({ db: mockDb, fileRepo });
      service.setFundUpdateApplyService(mockApplyService as any);
      return { mockDb, fileRepo, mockApplyService, service };
    };

    it('acquires transaction-scoped advisory lock using workspace key before file update', async () => {
      const { mockDb, fileRepo, service } = makeHarness([
        {
          submittedId: 'txn:AST-1:0:2024-01-01:contribution',
          family: 'transaction',
          disposition: 'posted',
        },
      ]);

      const asset = {
        code: 'AST-1',
        name: 'Asset 1',
        assetType: 'direct_investment',
        fund: 'Fund A',
        txns: [{ date: '2024-01-01', type: 'contribution', valueAmount: 100, currency: 'USD' }],
        valuations: [],
      };

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({
          id: 'file-lock-test',
          processing_status: 'awaiting_review',
          file_type: 'fund_updates',
          structured_notes: JSON.stringify({
            file_type: 'fund_updates',
            parser: 'startech_quarterly_v1',
            fund_update_proposal: {
              template_id: 'startech_quarterly_v1',
              stats: { asset_count: 1, direct_count: 1, fund_of_funds_count: 0 },
              assets: [asset],
              fund_catalog: ['Fund A'],
            },
          }),
        }),
      );

      const reviewData = await service.getReviewData('file-lock-test');
      if (reviewData.kind !== 'fund_updates') throw new Error('Expected fund update review');

      await service.approve('file-lock-test', {
        file_type: 'fund_updates',
        matched_company_id: null,
        two_step_approval: {
          entityDecisions: [
            { key: 'asset:AST-1', action: 'create' },
            { key: 'fund:Fund A', action: 'create' },
          ],
          transactions: [
            { id: reviewData.two_step_review.transactions[0].id },
          ],
          valuations: [],
        },
      });

      expect(mockDb.execute).toHaveBeenCalled();
      const callArg = (mockDb.execute as any).mock.calls[0][0];
      const sqlString = JSON.stringify(callArg);
      expect(sqlString).toContain('pg_advisory_xact_lock');
      expect(sqlString).toContain('fund-update-approval:workspace-1');
    });

    describe('post-import 基金汇总 check (MB-642)', () => {
      const catalogItems = [
        {
          nameZh: 'Fund A',
          nameEn: null,
          filingCode: null,
          subscribedAmount: 1_000,
          paidInAmount: 500,
          investedAmount: 100,
          netCashFlowAmount: 400,
        },
      ];

      const approveWithCatalog = async (
        service: ReturnType<typeof makeHarness>['service'],
        fileRepo: FileRepository,
        fundCatalogItems: unknown[],
      ) => {
        const asset = {
          code: 'AST-1',
          name: 'Asset 1',
          assetType: 'direct_investment',
          fund: 'Fund A',
          txns: [{ date: '2024-01-01', type: 'contribution', valueAmount: 100, currency: 'USD' }],
          valuations: [],
        };
        vi.mocked(fileRepo.findById).mockResolvedValue(
          makeFile({
            id: 'file-catalog-check',
            processing_status: 'awaiting_review',
            file_type: 'fund_updates',
            structured_notes: JSON.stringify({
              file_type: 'fund_updates',
              parser: 'nanjing_fund_ledger_v1',
              fund_update_proposal: {
                template_id: 'nanjing_fund_ledger_v1',
                stats: { asset_count: 1, direct_count: 1, fund_of_funds_count: 0 },
                assets: [asset],
                fund_catalog: ['Fund A'],
                fund_catalog_items: fundCatalogItems,
              },
            }),
          }),
        );
        const reviewData = await service.getReviewData('file-catalog-check');
        if (reviewData.kind !== 'fund_updates') throw new Error('Expected fund update review');
        return service.approve('file-catalog-check', {
          file_type: 'fund_updates',
          matched_company_id: null,
          two_step_approval: {
            entityDecisions: [
              { key: 'asset:AST-1', action: 'create' },
              { key: 'fund:Fund A', action: 'create' },
            ],
            transactions: [{ id: reviewData.two_step_review.transactions[0].id }],
            valuations: [],
          },
        });
      };

      const postedOutcome = [
        { submittedId: 'txn:AST-1:0:2024-01-01:contribution', family: 'transaction', disposition: 'posted' },
      ];

      it('attaches the check to the approval result and logs it on the extraction job', async () => {
        const { JobRepository } = await import('@/lib/repositories');
        const findSpy = vi
          .spyOn(JobRepository.prototype, 'findByTypeAndPayload')
          .mockResolvedValue([{ id: 'job-1' } as never]);
        const logSpy = vi.spyOn(JobRepository.prototype, 'appendLog').mockResolvedValue(undefined);
        const checkResult = {
          checked_funds: 1,
          differences: [
            { fund: 'Fund A', metric: 'cash', kind: 'posting', ledgerValue: 800, rowsValue: 400, catalogValue: 400, diff: 400 },
          ],
          skipped_funds: [],
          missing_funds: [],
          warnings: ['Fund A: ledger cash CNY 800 vs rows CNY 400 (diff +400).'],
          notes: [],
        };
        const checkAgainstCatalog = vi.fn().mockResolvedValue(checkResult);

        const { fileRepo, service } = makeHarness(postedOutcome);
        service.setFundCatalogCheckService({ checkAgainstCatalog } as any);

        const result = await approveWithCatalog(service, fileRepo, catalogItems);

        // Row totals come from the submitted rows; every row of Fund A was submitted.
        expect(checkAgainstCatalog).toHaveBeenCalledWith(catalogItems, {
          rowFigures: new Map([['fund a', { committed: 0, paidIn: 0, invested: 100 }]]),
          partialFunds: new Set(),
          fundsWithRows: new Set(['fund a']),
        });
        expect((result as any).fund_update.catalog_check).toEqual(checkResult);
        expect(findSpy).toHaveBeenCalledWith('fund_update_extraction', { fileId: 'file-catalog-check' });
        expect(logSpy).toHaveBeenCalledWith('job-1', {
          message: 'Post-import catalog check: 1 posting difference(s) in the written ledger',
          metadata: { catalog_check: checkResult },
        });
        findSpy.mockRestore();
        logSpy.mockRestore();
      });

      it('still completes the approval when the check throws', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const checkAgainstCatalog = vi.fn().mockRejectedValue(new Error('boom'));
        const { fileRepo, service } = makeHarness(postedOutcome);
        service.setFundCatalogCheckService({ checkAgainstCatalog } as any);

        const result = await approveWithCatalog(service, fileRepo, catalogItems);

        expect(checkAgainstCatalog).toHaveBeenCalled();
        expect((result as any).fund_update.catalog_check).toBeUndefined();
        expect(fileRepo.updatePartial).toHaveBeenCalledWith(
          'file-catalog-check',
          expect.objectContaining({ processing_status: 'completed' }),
          expect.anything(),
        );
        errorSpy.mockRestore();
      });

      it('still returns the check when logging it on the job fails', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { JobRepository } = await import('@/lib/repositories');
        const findSpy = vi
          .spyOn(JobRepository.prototype, 'findByTypeAndPayload')
          .mockRejectedValue(new Error('jobs down'));
        const checkResult = {
          checked_funds: 1,
          differences: [],
          skipped_funds: [],
          missing_funds: [],
          warnings: [],
          notes: [],
        };
        const { fileRepo, service } = makeHarness(postedOutcome);
        service.setFundCatalogCheckService({ checkAgainstCatalog: vi.fn().mockResolvedValue(checkResult) } as any);

        const result = await approveWithCatalog(service, fileRepo, catalogItems);

        expect((result as any).fund_update.catalog_check).toEqual(checkResult);
        findSpy.mockRestore();
        errorSpy.mockRestore();
      });

      it('skips the check when the summary states no figures', async () => {
        const checkAgainstCatalog = vi.fn();
        const { fileRepo, service } = makeHarness(postedOutcome);
        service.setFundCatalogCheckService({ checkAgainstCatalog } as any);

        const result = await approveWithCatalog(service, fileRepo, [
          { nameZh: 'Fund A', filingCode: null, subscribedAmount: null, paidInAmount: null, investedAmount: null },
        ]);

        expect(checkAgainstCatalog).not.toHaveBeenCalled();
        expect((result as any).fund_update.catalog_check).toBeUndefined();
      });
    });

    it('throws invariant violation and aborts approval when submitted transaction has no outcome', async () => {
      const { fileRepo, service } = makeHarness([]); // Outcomes empty -> missing transaction outcome

      const asset = {
        code: 'AST-1',
        name: 'Asset 1',
        assetType: 'direct_investment',
        fund: 'Fund A',
        txns: [{ date: '2024-01-01', type: 'contribution', valueAmount: 100, currency: 'USD' }],
        valuations: [],
      };

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({
          id: 'file-missing-outcome-tx',
          processing_status: 'awaiting_review',
          file_type: 'fund_updates',
          structured_notes: JSON.stringify({
            file_type: 'fund_updates',
            parser: 'startech_quarterly_v1',
            fund_update_proposal: {
              template_id: 'startech_quarterly_v1',
              stats: { asset_count: 1, direct_count: 1, fund_of_funds_count: 0 },
              assets: [asset],
              fund_catalog: ['Fund A'],
            },
          }),
        }),
      );

      const reviewData = await service.getReviewData('file-missing-outcome-tx');
      if (reviewData.kind !== 'fund_updates') throw new Error('Expected fund update review');
      const txnId = reviewData.two_step_review.transactions[0].id;

      await expect(
        service.approve('file-missing-outcome-tx', {
          file_type: 'fund_updates',
          matched_company_id: null,
          two_step_approval: {
            entityDecisions: [
              { key: 'asset:AST-1', action: 'create' },
              { key: 'fund:Fund A', action: 'create' },
            ],
            transactions: [{ id: txnId }],
            valuations: [],
          },
        }),
      ).rejects.toThrow(`Invariant violation: incomplete result - no outcome recorded for submitted transaction "${txnId}"`);

      expect(fileRepo.updatePartial).not.toHaveBeenCalledWith(
        'file-missing-outcome-tx',
        expect.objectContaining({ processing_status: 'completed' }),
        expect.anything(),
      );
    });

    it('throws invariant violation and aborts approval when submitted valuation has no outcome', async () => {
      const { fileRepo, service } = makeHarness([]); // Outcomes empty -> missing valuation outcome

      const asset = {
        code: 'AST-1',
        name: 'Asset 1',
        assetType: 'direct_investment',
        fund: 'Fund A',
        txns: [],
        valuations: [{ asOfDate: '2024-03-31', marketValue: 5000 }],
      };

      vi.mocked(fileRepo.findById).mockResolvedValue(
        makeFile({
          id: 'file-missing-outcome-val',
          processing_status: 'awaiting_review',
          file_type: 'fund_updates',
          structured_notes: JSON.stringify({
            file_type: 'fund_updates',
            parser: 'startech_quarterly_v1',
            fund_update_proposal: {
              template_id: 'startech_quarterly_v1',
              stats: { asset_count: 1, direct_count: 1, fund_of_funds_count: 0 },
              assets: [asset],
              fund_catalog: ['Fund A'],
            },
          }),
        }),
      );

      const reviewData = await service.getReviewData('file-missing-outcome-val');
      if (reviewData.kind !== 'fund_updates') throw new Error('Expected fund update review');
      const valId = reviewData.two_step_review.valuations[0].id;

      await expect(
        service.approve('file-missing-outcome-val', {
          file_type: 'fund_updates',
          matched_company_id: null,
          two_step_approval: {
            entityDecisions: [
              { key: 'asset:AST-1', action: 'create' },
              { key: 'fund:Fund A', action: 'create' },
            ],
            transactions: [],
            valuations: [{ id: valId }],
          },
        }),
      ).rejects.toThrow(`Invariant violation: incomplete result - no outcome recorded for submitted valuation "${valId}"`);

      expect(fileRepo.updatePartial).not.toHaveBeenCalledWith(
        'file-missing-outcome-val',
        expect.objectContaining({ processing_status: 'completed' }),
        expect.anything(),
      );
    });

    describe('Independent selected entity persistence and decision input validation', () => {
      it('rejects unknown entity key in approval.entityDecisions', async () => {
        const { fileRepo, service } = makeHarness([]);

        vi.mocked(fileRepo.findById).mockResolvedValue(
          makeFile({
            id: 'file-unknown-key',
            processing_status: 'awaiting_review',
            file_type: 'fund_updates',
            structured_notes: JSON.stringify({
              file_type: 'fund_updates',
              parser: 'startech_quarterly_v1',
              fund_update_proposal: {
                template_id: 'startech_quarterly_v1',
                stats: { asset_count: 1, direct_count: 1, fund_of_funds_count: 0 },
                assets: [{ code: 'AST-1', name: 'Asset 1', assetType: 'direct_investment', fund: 'Fund A', txns: [], valuations: [] }],
                fund_catalog: ['Fund A'],
              },
            }),
          }),
        );

        await expect(
          service.approve('file-unknown-key', {
            file_type: 'fund_updates',
            matched_company_id: null,
            two_step_approval: {
              entityDecisions: [
                { key: 'fund:NonExistentFund', action: 'create' },
              ],
              transactions: [],
              valuations: [],
            },
          }),
        ).rejects.toThrow('Unknown entity key "fund:NonExistentFund" submitted in approval decisions');
      });

      it('rejects duplicate entity key in approval.entityDecisions', async () => {
        const { fileRepo, service } = makeHarness([]);

        vi.mocked(fileRepo.findById).mockResolvedValue(
          makeFile({
            id: 'file-dup-key',
            processing_status: 'awaiting_review',
            file_type: 'fund_updates',
            structured_notes: JSON.stringify({
              file_type: 'fund_updates',
              parser: 'startech_quarterly_v1',
              fund_update_proposal: {
                template_id: 'startech_quarterly_v1',
                stats: { asset_count: 1, direct_count: 1, fund_of_funds_count: 0 },
                assets: [{ code: 'AST-1', name: 'Asset 1', assetType: 'direct_investment', fund: 'Fund A', txns: [], valuations: [] }],
                fund_catalog: ['Fund A'],
              },
            }),
          }),
        );

        await expect(
          service.approve('file-dup-key', {
            file_type: 'fund_updates',
            matched_company_id: null,
            two_step_approval: {
              entityDecisions: [
                { key: 'fund:Fund A', action: 'create' },
                { key: 'fund:Fund A', action: 'create' },
              ],
              transactions: [],
              valuations: [],
            },
          }),
        ).rejects.toThrow('Duplicate entity decision for key "fund:Fund A" submitted in approval');
      });

      it('rejects invalid entity action in approval.entityDecisions', async () => {
        const { fileRepo, service } = makeHarness([]);

        vi.mocked(fileRepo.findById).mockResolvedValue(
          makeFile({
            id: 'file-invalid-action',
            processing_status: 'awaiting_review',
            file_type: 'fund_updates',
            structured_notes: JSON.stringify({
              file_type: 'fund_updates',
              parser: 'startech_quarterly_v1',
              fund_update_proposal: {
                template_id: 'startech_quarterly_v1',
                stats: { asset_count: 1, direct_count: 1, fund_of_funds_count: 0 },
                assets: [{ code: 'AST-1', name: 'Asset 1', assetType: 'direct_investment', fund: 'Fund A', txns: [], valuations: [] }],
                fund_catalog: ['Fund A'],
              },
            }),
          }),
        );

        await expect(
          service.approve('file-invalid-action', {
            file_type: 'fund_updates',
            matched_company_id: null,
            two_step_approval: {
              entityDecisions: [
                { key: 'fund:Fund A', action: 'delete' as any },
              ],
              transactions: [],
              valuations: [],
            },
          }),
        ).rejects.toThrow('Invalid entity action "delete" for key "fund:Fund A"');
      });

      it('forwards standalone explicitly selected source, investor, and fund to applySelected with empty txns/valuations', async () => {
        const { fileRepo, mockApplyService, service } = makeHarness([]);

        const asset = {
          code: 'AST-STANDALONE',
          name: 'Target Tech Co',
          assetType: 'direct_investment',
          fund: 'Managing Fund 1',
          entity: 'HoldCo LP',
          fundingSource: 'DCA Source',
          txns: [],
          valuations: [],
        };

        vi.mocked(fileRepo.findById).mockResolvedValue(
          makeFile({
            id: 'file-standalone-entities',
            processing_status: 'awaiting_review',
            file_type: 'fund_updates',
            structured_notes: JSON.stringify({
              file_type: 'fund_updates',
              parser: 'startech_quarterly_v1',
              fund_update_proposal: {
                template_id: 'startech_quarterly_v1',
                stats: { asset_count: 1, direct_count: 1, fund_of_funds_count: 0 },
                assets: [asset],
                fund_catalog: ['Managing Fund 1'],
              },
            }),
          }),
        );

        await service.approve('file-standalone-entities', {
          file_type: 'fund_updates',
          matched_company_id: null,
          two_step_approval: {
            entityDecisions: [
              { key: 'source:DCA Source', action: 'create' },
              { key: 'investor:HoldCo LP', action: 'create' },
              { key: 'fund:Managing Fund 1', action: 'create' },
              { key: 'asset:AST-STANDALONE', action: 'create' },
            ],
            transactions: [],
            valuations: [],
          },
        });

        expect(mockApplyService.applySelected).toHaveBeenCalledWith(
          expect.anything(),
          expect.arrayContaining(['AST-STANDALONE']),
          expect.arrayContaining([
            expect.objectContaining({
              asset_code: 'AST-STANDALONE',
              txns: [],
              valuations: [],
            }),
          ]),
          expect.anything(),
          expect.objectContaining({
            funds: ['Managing Fund 1'],
            investors: ['HoldCo LP'],
            sources: ['DCA Source'],
          }),
          expect.anything(),
        );
      });

      it('excludes omitted entities from catalogSelections and selections', async () => {
        const { fileRepo, mockApplyService, service } = makeHarness([]);

        const asset = {
          code: 'AST-OMIT',
          name: 'Omitted Tech Co',
          assetType: 'direct_investment',
          fund: 'Managing Fund 1',
          entity: 'HoldCo LP',
          fundingSource: 'DCA Source',
          txns: [],
          valuations: [],
        };

        vi.mocked(fileRepo.findById).mockResolvedValue(
          makeFile({
            id: 'file-omitted-entities',
            processing_status: 'awaiting_review',
            file_type: 'fund_updates',
            structured_notes: JSON.stringify({
              file_type: 'fund_updates',
              parser: 'startech_quarterly_v1',
              fund_update_proposal: {
                template_id: 'startech_quarterly_v1',
                stats: { asset_count: 1, direct_count: 1, fund_of_funds_count: 0 },
                assets: [asset],
                fund_catalog: ['Managing Fund 1'],
              },
            }),
          }),
        );

        await service.approve('file-omitted-entities', {
          file_type: 'fund_updates',
          matched_company_id: null,
          two_step_approval: {
            entityDecisions: [
              { key: 'source:DCA Source', action: 'create' },
              { key: 'investor:HoldCo LP', action: 'omit' },
              { key: 'fund:Managing Fund 1', action: 'omit' },
              { key: 'asset:AST-OMIT', action: 'omit' },
            ],
            transactions: [],
            valuations: [],
          },
        });

        expect(mockApplyService.applySelected).toHaveBeenCalledWith(
          expect.anything(),
          [], // No asset codes because AST-OMIT is omitted
          [], // No derived asset selections
          expect.anything(),
          expect.objectContaining({
            funds: [],
            investors: [],
            sources: ['DCA Source'],
          }),
          expect.anything(),
        );
      });

      it('stages group entities into catalogSelections.funds and NOT into catalogSelections.investors', async () => {
        const { fileRepo, mockApplyService, service } = makeHarness([]);

        const asset = {
          code: 'AST-GRP',
          name: 'Group Portfolio Co',
          assetType: 'direct_investment',
          fund: 'Startech Growth Fund 1',
          entity: 'Startech Growth LP',
          group: 'Startech Growth Fund 1',
          holderKind: 'investor',
          txns: [],
          valuations: [],
        };

        vi.mocked(fileRepo.findById).mockResolvedValue(
          makeFile({
            id: 'file-group-catalog-selections',
            processing_status: 'awaiting_review',
            file_type: 'fund_updates',
            structured_notes: JSON.stringify({
              file_type: 'fund_updates',
              parser: 'startech_quarterly_v1',
              fund_update_proposal: {
                template_id: 'startech_quarterly_v1',
                stats: { asset_count: 1, direct_count: 1, fund_of_funds_count: 0 },
                assets: [asset],
              },
            }),
          }),
        );

        await service.approve('file-group-catalog-selections', {
          file_type: 'fund_updates',
          matched_company_id: null,
          two_step_approval: {
            entityDecisions: [
              { key: 'group:Startech Growth Fund 1', action: 'create' },
              { key: 'investor:Startech Growth LP', action: 'create' },
              { key: 'asset:AST-GRP', action: 'create' },
            ],
            transactions: [],
            valuations: [],
          },
        });

        expect(mockApplyService.applySelected).toHaveBeenCalledWith(
          expect.anything(),
          expect.arrayContaining(['AST-GRP']),
          expect.anything(),
          expect.anything(),
          expect.objectContaining({
            funds: expect.arrayContaining(['Startech Growth Fund 1']),
            investors: expect.arrayContaining(['Startech Growth LP']),
          }),
        );

        // Verify group appears in catalogSelections.funds and NOT in catalogSelections.investors
        const lastCall = vi.mocked(mockApplyService.applySelected).mock.calls.at(-1);
        const passedCatalogSelections = lastCall ? lastCall[4] : undefined;
        expect(passedCatalogSelections?.funds).toContain('Startech Growth Fund 1');
        expect(passedCatalogSelections?.investors).not.toContain('Startech Growth Fund 1');
        expect(passedCatalogSelections?.investors).toContain('Startech Growth LP');
      });

      it('round-trips parsed FORE transaction and valuation rows through prevalidation without throwing', async () => {
        const { fileRepo, mockApplyService, service } = makeHarness([]);

        const foreAsset = {
          code: 'FORE',
          name: 'FORE Co',
          assetType: 'direct_investment',
          fund: 'Fund A',
          entity: 'Investor A',
          txns: [
            {
              date: '2019-04-26',
              type: 'contribution',
              subTypeLabel: null,
              pricePerShare: 17.97756389,
              shareCount: 30598,
              valueAmount: 550077.5,
              currency: 'USD',
              fxRate: null,
              notes: null,
              sellProceedsDestination: null,
            },
          ],
          valuations: [
            {
              asOfDate: '2019-06-30',
              periodLabel: 'Q2 2019',
              marketValue: 550077.5,
              pricePerShare: 17.97756389,
              sharesOutstanding: 30598,
              shareholdingPct: null,
              investedCapitalCum: null,
              grossMoic: null,
              grossXirr: null,
              valuationMethod: 'stock_market_price',
              notes: null,
            },
          ],
        };

        vi.mocked(fileRepo.findById).mockResolvedValue(
          makeFile({
            id: 'file-fore-preval',
            processing_status: 'awaiting_review',
            file_type: 'fund_updates',
            structured_notes: JSON.stringify({
              file_type: 'fund_updates',
              parser: 'startech_quarterly_v1',
              fund_update_proposal: {
                template_id: 'startech_quarterly_v1',
                stats: { asset_count: 1, direct_count: 1, fund_of_funds_count: 0 },
                assets: [foreAsset],
                fund_catalog: ['Fund A'],
              },
            }),
          }),
        );

        const reviewData = await service.getReviewData('file-fore-preval');
        if (reviewData.kind !== 'fund_updates') throw new Error('Expected fund update review');

        const reviewTxn = reviewData.two_step_review.transactions[0];
        const reviewVal = reviewData.two_step_review.valuations[0];
        expect(reviewTxn.pricePerShare).toBe(17.97756389);
        expect(reviewVal.pricePerShare).toBe(17.97756389);

        mockApplyService.applySelected.mockResolvedValue({
          applied: 1,
          created_assets: 1,
          updated_assets: 0,
          created_funds: 0,
          skipped: 0,
          txns_inserted: 1,
          valuations_upserted: 1,
          outcomes: [
            {
              submittedId: reviewTxn.id,
              family: 'transaction',
              disposition: 'inserted',
              persistedTable: 'fl_ledger_entries',
              persistedId: 'ent-1',
              targetId: 'pos-1',
              assetCode: 'FORE',
            },
            {
              submittedId: reviewVal.id,
              family: 'valuation',
              disposition: 'upserted',
              persistedTable: 'fl_valuations',
              persistedId: 'val-1',
              targetId: 'pos-1',
              assetCode: 'FORE',
            },
          ],
        });

        // Prevalidation round-trip succeeds for parsed positive pricePerShare
        await expect(
          service.approve('file-fore-preval', {
            file_type: 'fund_updates',
            matched_company_id: null,
            two_step_approval: {
              entityDecisions: [
                { key: 'asset:FORE', action: 'create' },
                { key: 'fund:Fund A', action: 'create' },
                { key: 'investor:Investor A', action: 'create' },
              ],
              transactions: [
                {
                  id: reviewTxn.id,
                  edits: {
                    date: reviewTxn.date,
                    amount: reviewTxn.amount,
                    cashDelta: reviewTxn.cashDelta,
                    pricePerShare: reviewTxn.pricePerShare,
                  },
                },
              ],
              valuations: [
                {
                  id: reviewVal.id,
                  edits: {
                    asOfDate: reviewVal.asOfDate,
                    marketValue: reviewVal.marketValue,
                    pricePerShare: reviewVal.pricePerShare,
                  },
                },
              ],
            },
          }),
        ).resolves.not.toThrow();

        // Guard remains active: prevalidation refuses negative pricePerShare
        await expect(
          service.approve('file-fore-preval', {
            file_type: 'fund_updates',
            matched_company_id: null,
            two_step_approval: {
              entityDecisions: [
                { key: 'asset:FORE', action: 'create' },
                { key: 'fund:Fund A', action: 'create' },
                { key: 'investor:Investor A', action: 'create' },
              ],
              transactions: [
                {
                  id: reviewTxn.id,
                  edits: {
                    pricePerShare: -17.97756389,
                  },
                },
              ],
              valuations: [],
            },
          }),
        ).rejects.toThrow('Invalid pricePerShare "-17.97756389" for transaction');
      });
    });
  });
});

describe('FileService.processUpload — telemetry', () => {
  let fileRepo: FileRepository;
  let service: FileService;

  beforeEach(() => {
    posthogMocks.captureWorkspaceEvent.mockReset();
    fileRepo = makeFileRepoStub();
    service = new FileService(
      null as unknown as DbClient,
      'workspace-1',
      fileRepo,
      makeCompanyAnalysisServiceStub(),
      makeAIScreeningServiceStub(),
      makeCriteriaRepoStub(),
      makeScreeningRepoStub(),
      makeCompanyFinancialRepoStub(),
      makeCompanyServiceStub(),
      makeCompanyFxAdjustmentRepoStub(),
      makeUserWorkspaceRepoStub(),
    );

    vi.mocked(downloadFile).mockResolvedValue(Buffer.from('content'));
    vi.mocked(getSignedUrl).mockResolvedValue('https://signed-url');
    vi.mocked(fileRepo.insert).mockResolvedValue(
      makeFile({ id: 'file-1', processing_status: 'processing' }),
    );
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', processing_status: 'completed' }),
    );
    vi.mocked(processFileContent).mockResolvedValue(null);
  });

  it('captures file_uploaded against the uploading session user', async () => {
    await service.processUpload(
      'uploads/report.pdf',
      'report.pdf',
      'application/pdf',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'user-7',
    );

    expect(posthogMocks.captureWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'workspace-1',
        distinctId: 'user-7',
        event: 'file_uploaded',
        properties: expect.objectContaining({
          file_id: 'file-1',
          file_name: 'report.pdf',
          content_type: 'application/pdf',
          source: 'user',
        }),
      }),
    );
  });

  it("attributes a pipeline ingest with no session to 'server'", async () => {
    await service.processUpload('uploads/report.pdf', 'report.pdf', 'application/pdf');

    expect(posthogMocks.captureWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: 'server',
        properties: expect.objectContaining({ source: 'pipeline' }),
      }),
    );
  });

  it('does not capture an upload that was rejected as a duplicate', async () => {
    vi.mocked(fileRepo.findFirstByName).mockResolvedValue(
      makeFile({ id: 'file-existing', file_name: 'report.pdf' }),
    );
    vi.mocked(deleteFile).mockResolvedValue(undefined as never);

    await service.processUpload('uploads/copy.pdf', 'report.pdf', 'application/pdf');

    expect(posthogMocks.captureWorkspaceEvent).not.toHaveBeenCalled();
  });

  it('captures exactly once per upload', async () => {
    await service.processUpload('uploads/report.pdf', 'report.pdf', 'application/pdf');

    const uploads = posthogMocks.captureWorkspaceEvent.mock.calls.filter(
      ([arg]) => arg.event === 'file_uploaded',
    );
    expect(uploads).toHaveLength(1);
  });
});

/**
 * Minimal chainable Drizzle stub: enough for the real `FileRepository`
 * instances that `processUpload` builds for secondary fan-out workspaces.
 */
function makeChainableDb(): DbClient {
  const chain: any = {
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    select: vi.fn(() => chain),
    values: vi.fn(() => chain),
    set: vi.fn(() => chain),
    from: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    returning: vi.fn().mockResolvedValue([{ id: 'file-secondary' }]),
    transaction: async (cb: (tx: any) => Promise<any>) => cb(chain),
    execute: vi.fn().mockResolvedValue([]),
  };
  return chain as unknown as DbClient;
}

describe('FileService.processUpload email-ingest notification', () => {
  const CUSTODIAN = 'jane@corp.com';

  function makeWorkspace(id: string, name: string, slug: string) {
    return { id, name, slug, deleted_at: null } as unknown as Tables<'workspaces'>;
  }

  function setup(
    opts: {
      file?: Partial<FileRow>;
      workspaces?: Tables<'workspaces'>[];
      workspaceIds?: string[];
      user?: Partial<Tables<'users'>> | null;
      withWorkspaceRepo?: boolean;
      classified?: Record<string, unknown>;
    } = {},
  ) {
    const fileRepo = makeFileRepoStub();
    const enqueueEmail = vi.fn().mockResolvedValue({ messageId: 'm1' });
    const findActiveByIds = vi
      .fn()
      .mockResolvedValue(opts.workspaces ?? [makeWorkspace('workspace-1', 'MNA', 'mna')]);
    const userRepo = {
      findByEmail: vi
        .fn()
        .mockResolvedValue(
          opts.user === null ? undefined : { id: 'user-1', name: 'Jane', ...opts.user },
        ),
    };
    const userWorkspaceRepo = {
      findWorkspaceIdsBySyncedEmail: vi
        .fn()
        .mockResolvedValue(opts.workspaceIds ?? ['workspace-1']),
    } as unknown as UserWorkspaceRepository;

    const service = new FileService(
      // The multi-workspace fan-out builds a real FileRepository per secondary
      // workspace straight off this client, so it needs the Drizzle chain.
      makeChainableDb(),
      'workspace-1',
      fileRepo,
      makeCompanyAnalysisServiceStub(),
      makeAIScreeningServiceStub(),
      makeCriteriaRepoStub(),
      makeScreeningRepoStub(),
      makeCompanyFinancialRepoStub(),
      makeCompanyServiceStub(),
      makeCompanyFxAdjustmentRepoStub(),
      userWorkspaceRepo,
      undefined,
      userRepo as never,
      enqueueEmail,
    );
    if (opts.withWorkspaceRepo !== false) {
      service.setWorkspaceRepo({ findActiveByIds } as never);
    }

    vi.mocked(downloadFile).mockResolvedValue(Buffer.from('a'.repeat(2048)));
    vi.mocked(getSignedUrl).mockResolvedValue('https://signed-url');
    vi.mocked(fileRepo.insert).mockResolvedValue(
      makeFile({ id: 'file-1', processing_status: 'processing' }),
    );
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({
        id: 'file-1',
        file_name: 'Teaser.pdf',
        file_type: 'prospectus',
        processing_status: 'completed',
        ...opts.file,
      }),
    );
    // Anything but `other` — an email-origin file classified `other` is
    // auto-dropped and returns before the notification.
    vi.mocked(processFileContent).mockResolvedValue(
      (opts.classified ?? { file_type: 'prospectus' }) as never,
    );
    vi.mocked(deleteFile).mockResolvedValue(undefined as never);

    return { service, enqueueEmail, findActiveByIds, userRepo, fileRepo };
  }

  const EMAIL_CONTEXT = {
    senderName: 'John Banker',
    senderEmail: 'john@bank.com',
    subject: 'Project Atlas — teaser attached',
    receivedAt: '2026-09-28T14:32:00.000Z',
  };

  it('enqueues an email_pdf_ingested notification to the crawled mailbox', async () => {
    const { service, enqueueEmail } = setup();

    await service.processUpload(
      'uploads/Teaser.pdf',
      'Teaser.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
      undefined,
      CUSTODIAN,
      null,
      EMAIL_CONTEXT,
    );

    expect(enqueueEmail).toHaveBeenCalledTimes(1);
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'email_pdf_ingested',
        to: CUSTODIAN,
        recipientName: 'Jane',
        fileName: 'Teaser.pdf',
        workspaceName: 'MNA',
        fileTypeLabel: 'Prospectus',
        fileSizeLabel: '2.0 KB',
        emailSender: 'John Banker <john@bank.com>',
        emailSubject: 'Project Atlas — teaser attached',
        emailReceivedLabel: '28 Sep 2026, 14:32 UTC',
        awaitingReview: false,
        additionalWorkspaces: [],
      }),
    );
    expect(enqueueEmail.mock.calls[0][0].fileUrl).toMatch(/\/w\/mna\/smart-files$/);
  });

  it('does not notify for manual (non-email) uploads', async () => {
    const { service, enqueueEmail } = setup();
    await service.processUpload('uploads/Teaser.pdf', 'Teaser.pdf', 'application/pdf');
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('does not notify for non-PDF email attachments', async () => {
    const { service, enqueueEmail } = setup({ file: { file_name: 'model.xlsx' } });
    await service.processUpload(
      'uploads/model.xlsx',
      'model.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      undefined,
      undefined,
      true,
      undefined,
      CUSTODIAN,
    );
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('does not notify when the attachment duplicates an existing file', async () => {
    const { service, enqueueEmail, fileRepo } = setup();
    vi.mocked(fileRepo.findFirstByName).mockResolvedValue(
      makeFile({ id: 'file-existing', file_name: 'Teaser.pdf', processing_status: 'completed' }),
    );

    await service.processUpload(
      'uploads/Teaser.pdf',
      'Teaser.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
      undefined,
      CUSTODIAN,
    );

    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('does not notify for an email file auto-dropped as `other`', async () => {
    const { service, enqueueEmail } = setup({
      classified: { file_type: 'other' },
      file: { processing_status: 'dropped', drop_reason: 'afd_classified_other' },
    });
    await service.processUpload(
      'uploads/Receipt.pdf',
      'Receipt.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
      undefined,
      CUSTODIAN,
    );
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('does not notify when processing failed', async () => {
    const { service, enqueueEmail } = setup({ file: { processing_status: 'failed' } });
    await service.processUpload(
      'uploads/Teaser.pdf',
      'Teaser.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
      undefined,
      CUSTODIAN,
    );
    expect(enqueueEmail).not.toHaveBeenCalled();
  });

  it('flags a file that landed in the review queue', async () => {
    const { service, enqueueEmail } = setup({
      file: { processing_status: 'awaiting_review' },
    });
    await service.processUpload(
      'uploads/Teaser.pdf',
      'Teaser.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
      undefined,
      CUSTODIAN,
    );
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ awaitingReview: true }),
    );
  });

  it('names every workspace the mailbox fanned the file out to', async () => {
    const { service, enqueueEmail } = setup({
      workspaceIds: ['workspace-1', 'workspace-2'],
      workspaces: [
        makeWorkspace('workspace-1', 'MNA', 'mna'),
        makeWorkspace('workspace-2', 'Ventures', 'ventures'),
      ],
    });
    await service.processUpload(
      'uploads/Teaser.pdf',
      'Teaser.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
      undefined,
      CUSTODIAN,
    );
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceName: 'MNA',
        additionalWorkspaces: ['Ventures'],
      }),
    );
  });

  it('resolves workspace names in a single batched query', async () => {
    const { service, findActiveByIds } = setup({
      workspaceIds: ['workspace-1', 'workspace-2'],
      workspaces: [
        makeWorkspace('workspace-1', 'MNA', 'mna'),
        makeWorkspace('workspace-2', 'Ventures', 'ventures'),
      ],
    });
    await service.processUpload(
      'uploads/Teaser.pdf',
      'Teaser.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
      undefined,
      CUSTODIAN,
    );
    expect(findActiveByIds).toHaveBeenCalledTimes(1);
    expect(findActiveByIds).toHaveBeenCalledWith(['workspace-1', 'workspace-2']);
  });

  it('still notifies the mailbox when the custodian has no user row', async () => {
    const { service, enqueueEmail } = setup({ user: null });
    await service.processUpload(
      'uploads/Teaser.pdf',
      'Teaser.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
      undefined,
      CUSTODIAN,
    );
    expect(enqueueEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: CUSTODIAN, recipientName: undefined }),
    );
  });

  it('skips the notification when the workspace name cannot be resolved', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { service, enqueueEmail } = setup({ workspaces: [] });
    await service.processUpload(
      'uploads/Teaser.pdf',
      'Teaser.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
      undefined,
      CUSTODIAN,
    );
    expect(enqueueEmail).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('never fails the upload when enqueueing the notification throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { service, enqueueEmail } = setup();
    enqueueEmail.mockRejectedValue(new Error('queue down'));

    const result = await service.processUpload(
      'uploads/Teaser.pdf',
      'Teaser.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
      undefined,
      CUSTODIAN,
    );

    expect(result).toMatchObject({ id: 'file-1' });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('FileService.getStatus', () => {
  it('returns only the id, name, type and processing status of the file', async () => {
    const fileRepo = makeFileRepoStub();
    (fileRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'file-1',
      file_name: 'Q3 update.xlsx',
      file_type: 'fund_updates',
      processing_status: 'processing',
      raw_notes: 'not returned',
      file_link: 'uploads/q3.xlsx',
    });
    const service = makeService({ fileRepo });

    await expect(service.getStatus('file-1')).resolves.toEqual({
      id: 'file-1',
      file_name: 'Q3 update.xlsx',
      file_type: 'fund_updates',
      processing_status: 'processing',
    });
    expect(fileRepo.findById).toHaveBeenCalledWith('file-1');
  });
});

describe('FileService.getDetail', () => {
  it('returns the full file record with a signed preview url', async () => {
    const fileRepo = makeFileRepoStub();
    const record = {
      id: 'file-1',
      file_name: 'Deck.pdf',
      file_link: 'uploads/deck.pdf',
      structured_notes: '{"summary":"s"}',
    };
    (fileRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce(record);
    vi.mocked(getSignedUrl).mockResolvedValueOnce('https://signed/deck.pdf');
    const service = makeService({ fileRepo });

    await expect(service.getDetail('file-1')).resolves.toEqual({
      ...record,
      signed_url: 'https://signed/deck.pdf',
    });
    expect(fileRepo.findById).toHaveBeenCalledWith('file-1');
    expect(getSignedUrl).toHaveBeenCalledWith('uploads/deck.pdf');
  });

  it('returns a null signed url when signing fails', async () => {
    const fileRepo = makeFileRepoStub();
    (fileRepo.findById as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'file-1',
      file_link: 'uploads/deck.pdf',
    });
    vi.mocked(getSignedUrl).mockRejectedValueOnce(new Error('S3 down'));
    const service = makeService({ fileRepo });

    await expect(service.getDetail('file-1')).resolves.toMatchObject({ signed_url: null });
  });

  it('propagates not-found from the repository', async () => {
    const fileRepo = makeFileRepoStub();
    (fileRepo.findById as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('File file-9 not found'),
    );
    const service = makeService({ fileRepo });

    await expect(service.getDetail('file-9')).rejects.toThrow(/not found/);
  });
});
