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

function makeCriteria(id: string): CriteriaRow {
  return {
    id,
    name: `Criteria ${id}`,
    prompt: `Prompt for ${id}`,
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

  it('marks status as awaiting_review for prospectus files', async () => {
    vi.mocked(processFileContent).mockResolvedValue({ file_type: 'prospectus' } as never);

    await service.processUpload('uploads/report.pdf', 'report.pdf', 'application/pdf');

    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({ processing_status: 'awaiting_review' }),
    );
  });

  it('marks status as awaiting_review when fileTypeOverride is prospectus', async () => {
    await service.processUpload(
      'uploads/report.pdf',
      'report.pdf',
      'application/pdf',
      undefined,
      'prospectus',
    );

    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({ processing_status: 'awaiting_review' }),
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

  it('does not dispatch company analysis during processUpload', async () => {
    vi.mocked(processFileContent).mockResolvedValue({ file_type: 'prospectus' } as never);

    await service.processUpload('uploads/report.pdf', 'report.pdf', 'application/pdf');

    expect(companyAnalysisService.dispatch).not.toHaveBeenCalled();
  });

  it('does not dispatch AI screening during processUpload', async () => {
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

  it('merges email-origin attachment data into an existing matched company', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'teaser',
      matched_companies: [{ id: 'company-existing', type: 'company' }],
      prospectus_summary: {
        company_name: 'Acme Corp',
        segment: 'Industrial Tech',
        financials: [
          {
            fiscal_year: 2024,
            revenue_usd_mn: 42,
            ev_usd_mn: 120,
          },
        ],
      },
    } as never);
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ id: 'company-existing', target: 'Acme Corp' }),
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

    expect(companyService.updateFromDTO).toHaveBeenCalledWith(
      'company-existing',
      expect.objectContaining({
        target: 'Acme Corp',
        segment: 'Industrial Tech',
        doc_type: 'teaser',
        banker_source: 'Goldman Sachs',
        revenue_2024_usd_mn: 42,
        ev_2024: 120,
      }),
      'merged_from_email_attachment:file-1',
    );
    const updates = vi.mocked(companyService.updateFromDTO).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updates.website).toBeUndefined();
    expect(updates.ebitda_2024_usd_mn).toBeUndefined();
    expect(companyService.createFromDTO).not.toHaveBeenCalled();
    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({
        matched_companies: expect.arrayContaining([
          expect.objectContaining({ id: 'company-existing' }),
        ]),
      }),
    );
  });

  it('creates an unreviewed email-origin company when no existing company matches', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'teaser',
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
        review_state: 'unreviewed',
        banker_source: 'Goldman Sachs',
      }),
      'auto_created_from_email_attachment:file-1',
    );
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
    };
    await service.approve('file-1', input);

    expect(companyService.createFromDTO).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'Acme Corp', source: 'inbound' }),
      'created_from_file:file-1',
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

  it('dispatches screening jobs and marks failed on dispatch error', async () => {
    vi.mocked(fileRepo.findById).mockResolvedValue(
      makeFile({ id: 'file-1', structured_notes: prospectusNotes }),
    );
    vi.mocked(companyService.findById).mockResolvedValue(makeCompany());
    vi.mocked(criteriaRepo.findAll).mockResolvedValue([makeCriteria('c-1')]);
    vi.mocked(screeningRepo.insert).mockResolvedValue(makeScreening('s-1'));
    vi.mocked(aiScreeningService.dispatch).mockRejectedValue(new Error('fail'));

    const input: ApproveFileInput = { file_type: 'prospectus', matched_company_id: 'company-1' };
    await service.approve('file-1', input);

    await vi.waitFor(() => {
      expect(screeningRepo.update).toHaveBeenCalledWith('s-1', expect.objectContaining({ state: 'failed' }));
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
