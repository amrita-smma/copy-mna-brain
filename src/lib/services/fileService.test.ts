import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  FileRepository,
  CriteriaRepository,
  ScreeningRepository,
  CompanyFinancialRepository,
  CompanyFxAdjustmentRepository,
  DbClient,
  Tables,
} from '@/lib/repositories';
import type { CompanyAnalysisService } from './companyAnalysisService';
import type { AIScreeningService } from './aiScreeningService';
import type { CompanyService } from './companyService';
import { FileService, type ApproveFileInput } from './fileService';

vi.mock('@/lib/s3', () => ({
  downloadFile: vi.fn(),
  getSignedUrl: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock('@/lib/fileExtractor', () => ({
  extractTextFromFile: vi.fn(),
}));

vi.mock('@/lib/agents/file_processing', () => ({
  processFileContent: vi.fn(),
}));

import { downloadFile, getSignedUrl, deleteFile } from '@/lib/s3';
import { extractTextFromFile } from '@/lib/fileExtractor';
import { processFileContent } from '@/lib/agents/file_processing';

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
    processing_status: 'pending',
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

function makeFileRepoStub(): FileRepository {
  return {
    findById: vi.fn(),
    findLinkAndNameById: vi.fn(),
    findAll: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    updatePartial: vi.fn(),
    delete: vi.fn(),
    searchForAgent: vi.fn(),
  } as unknown as FileRepository;
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

function makeCompanyAnalysisServiceStub(): CompanyAnalysisService {
  return {
    dispatch: vi.fn(),
    findByCompanyId: vi.fn(),
    delete: vi.fn(),
  } as unknown as CompanyAnalysisService;
}

function makeAIScreeningServiceStub(): AIScreeningService {
  return {
    dispatch: vi.fn(),
  } as unknown as AIScreeningService;
}

function makeCompanyServiceStub(): CompanyService {
  return {
    findById: vi.fn().mockResolvedValue(makeCompany()),
    findByNameFuzzy: vi.fn().mockResolvedValue(null),
    createFromDTO: vi.fn().mockResolvedValue({ id: 'company-new' }),
    markPossibleDuplicate: vi.fn().mockResolvedValue(undefined),
    updateFromDTO: vi.fn().mockResolvedValue({ id: 'company-1' }),
    listIdAndTargetPage: vi.fn(),
  } as unknown as CompanyService;
}

function makeService(overrides: {
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
    null as unknown as DbClient,
    overrides.fileRepo ?? makeFileRepoStub(),
    overrides.companyAnalysisService ?? makeCompanyAnalysisServiceStub(),
    overrides.aiScreeningService ?? makeAIScreeningServiceStub(),
    overrides.criteriaRepo ?? makeCriteriaRepoStub(),
    overrides.screeningRepo ?? makeScreeningRepoStub(),
    overrides.companyFinancialRepo ?? makeCompanyFinancialRepoStub(),
    overrides.companyService ?? makeCompanyServiceStub(),
    overrides.companyFxAdjustmentRepo ?? makeCompanyFxAdjustmentRepoStub(),
  );
}

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
      fileRepo,
      companyAnalysisService,
      aiScreeningService,
      criteriaRepo,
      screeningRepo,
      companyFinancialRepo,
      companyService,
      makeCompanyFxAdjustmentRepoStub(),
    );

    vi.mocked(downloadFile).mockResolvedValue(Buffer.from('content'));
    vi.mocked(getSignedUrl).mockResolvedValue('https://signed-url');
    vi.mocked(fileRepo.insert).mockResolvedValue(makeFile({ id: 'file-1', processing_status: 'processing' }));
    vi.mocked(fileRepo.findById).mockResolvedValue(makeFile({ id: 'file-1', processing_status: 'completed' }));
    vi.mocked(processFileContent).mockResolvedValue(null);
    vi.mocked(criteriaRepo.findAll).mockResolvedValue([]);
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

    expect(screeningRepo.insert).not.toHaveBeenCalled();
    expect(aiScreeningService.dispatch).not.toHaveBeenCalled();
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
    );
    expect(companyService.createFromDTO).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ target: 'Beta Ltd', segment: 'Healthcare' }),
      'auto_created_from_file:file-1',
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
      expect(aiScreeningService.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ companyId: 'company-b' }),
      );
    });
  });

  it('does not auto-create a company from a market_study email attachment', async () => {
    // A market study describes a sector/landscape, not a company on sale —
    // it must not mint a deal target even if the AFD names a company. (MB-300)
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
      fileRepo,
      companyAnalysisService,
      aiScreeningService,
      criteriaRepo,
      screeningRepo,
      companyFinancialRepo,
      companyService,
      makeCompanyFxAdjustmentRepoStub(),
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
      null as unknown as DbClient,
      fileRepo,
      companyAnalysisService,
      aiScreeningService,
      criteriaRepo,
      screeningRepo,
      companyFinancialRepo,
      companyService,
      companyFxAdjustmentRepo,
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

  it('throws CompanyL0RequirementsError when required fields are missing', async () => {
    const { CompanyL0RequirementsError } = await import('./companyService');
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', structured_notes: prospectusNotes }),
    );
    const input: ApproveFileInput = {
      file_type: 'prospectus',
      matched_company_id: null,
      create_company_from_ai: true,
      // entered_by, deal_type, banker all absent
    };
    await expect(service.approve('file-1', input)).rejects.toBeInstanceOf(CompanyL0RequirementsError);
    expect(companyService.createFromDTO).not.toHaveBeenCalled();
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

  it('dispatches screening jobs and marks failed on dispatch error', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', structured_notes: prospectusNotes }),
    );
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ matched_track_ids: ['track-1'] }),
    );
    vi.mocked(criteriaRepo.findAll).mockResolvedValue([makeCriteria('c-1', 'track-1')]);
    vi.mocked(screeningRepo.insert).mockResolvedValue(makeScreening('s-1'));
    vi.mocked(aiScreeningService.dispatch).mockRejectedValue(new Error('fail'));

    const input: ApproveFileInput = { file_type: 'prospectus', matched_company_id: 'company-1' };
    await service.approve('file-1', input);

    await vi.waitFor(() => {
      expect(screeningRepo.update).toHaveBeenCalledWith('s-1', expect.objectContaining({ state: 'failed' }));
    });
  });

  it('screens only criteria belonging to the company\'s matched tracks', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', structured_notes: prospectusNotes }),
    );
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ matched_track_ids: ['track-1'] }),
    );
    // c-1 belongs to the matched track; c-2 belongs to an unmatched track and
    // must be skipped; c-3 has no track and must be skipped.
    vi.mocked(criteriaRepo.findAll).mockResolvedValue([
      makeCriteria('c-1', 'track-1'),
      makeCriteria('c-2', 'track-2'),
      makeCriteria('c-3', null),
    ]);
    vi.mocked(screeningRepo.insert).mockResolvedValue(makeScreening('s-1'));

    const input: ApproveFileInput = { file_type: 'prospectus', matched_company_id: 'company-1' };
    await service.approve('file-1', input);

    await vi.waitFor(() => {
      expect(screeningRepo.insert).toHaveBeenCalledTimes(1);
    });
    expect(screeningRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ criteria_id: 'c-1', track_id: 'track-1' }),
    );
    expect(aiScreeningService.dispatch).toHaveBeenCalledTimes(1);
    expect(aiScreeningService.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ criteriaId: 'c-1' }),
    );
  });

  it('does not screen when the company has no matched tracks', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', structured_notes: prospectusNotes }),
    );
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ matched_track_ids: [] }),
    );
    vi.mocked(criteriaRepo.findAll).mockResolvedValue([makeCriteria('c-1', 'track-1')]);

    const input: ApproveFileInput = { file_type: 'prospectus', matched_company_id: 'company-1' };
    await service.approve('file-1', input);

    expect(screeningRepo.insert).not.toHaveBeenCalled();
    expect(aiScreeningService.dispatch).not.toHaveBeenCalled();
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
      fileRepo,
      makeCompanyAnalysisServiceStub(),
      makeAIScreeningServiceStub(),
      makeCriteriaRepoStub(),
      makeScreeningRepoStub(),
      companyFinancialRepo,
      companyService,
      companyFxAdjustmentRepo,
    );

    const result = await service.getReviewData('file-1');

    expect(result.current.company?.id).toBe('company-1');
  });

  it('returns null current.company when no matched company', async () => {
    const fileRepo = makeFileRepoStub();
    vi.mocked(fileRepo.findById).mockResolvedValue(makeFile({ id: 'file-1', matched_companies: [] }));

    const service = makeService({ fileRepo });
    const result = await service.getReviewData('file-1');

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
    expect(result.ai.suggested_company).toMatchObject({
      target: 'Beta Ltd',
      segment: 'Healthcare',
    });
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
});
