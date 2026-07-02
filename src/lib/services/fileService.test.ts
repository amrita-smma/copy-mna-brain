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
      file_type: 'prospectus',
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
        doc_type: 'prospectus',
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
      'auto_created_from_email_attachment:file-1',
    );
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

  it('does not blank company or project names when merging email-origin attachments', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
      matched_companies: [{ id: 'company-existing', type: 'company' }],
      prospectus_summary: {
        company_name: '   ',
        project_name: '',
        segment: 'Industrial Tech',
      },
    } as never);
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ id: 'company-existing', target: 'Acme Corp', project_name: 'Project Falcon' }),
    );

    await service.processUpload(
      'uploads/teaser.pdf',
      'teaser.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
    );

    const updates = vi.mocked(companyService.updateFromDTO).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updates).toMatchObject({
      source: 'inbound',
      doc_type: 'prospectus',
      segment: 'Industrial Tech',
    });
    expect(updates.target).toBeUndefined();
    expect(updates.project_name).toBeUndefined();
    expect(companyService.createFromDTO).not.toHaveBeenCalled();
  });

  it('merges email-origin attachment data into an outbound matched company without changing source', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
      matched_companies: [{ id: 'company-outbound', type: 'company' }],
      prospectus_summary: {
        company_name: 'Acme Corp',
        segment: 'Industrial Tech',
      },
    } as never);
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ id: 'company-outbound', source: 'outbound' }),
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
      'company-outbound',
      expect.objectContaining({
        target: 'Acme Corp',
        source: 'outbound',
        segment: 'Industrial Tech',
      }),
      'merged_from_email_attachment:file-1',
    );
    expect(companyService.createFromDTO).not.toHaveBeenCalled();
  });

  it('merges email-origin attachment data into a fuzzy-matched company before creating', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
      prospectus_summary: {
        company_name: 'Acme Corp',
        project_name: 'Project Falcon',
      },
    } as never);
    vi.mocked(companyService.findByNameFuzzy).mockResolvedValue(
      makeCompany({ id: 'company-existing', target: 'Acme Corp' }) as never,
    );
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

    expect(companyService.findByNameFuzzy).toHaveBeenCalledWith('Acme Corp');
    expect(companyService.updateFromDTO).toHaveBeenCalledWith(
      'company-existing',
      expect.objectContaining({
        target: 'Acme Corp',
        project_name: 'Project Falcon',
      }),
      'merged_from_email_attachment:file-1',
    );
    expect(companyService.createFromDTO).not.toHaveBeenCalled();
    expect(fileRepo.updatePartial).toHaveBeenCalledWith(
      'file-1',
      expect.objectContaining({
        matched_companies: [expect.objectContaining({ id: 'company-existing' })],
      }),
    );
  });

  it('merges email-origin attachment data into an outbound fuzzy match without changing source', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
      prospectus_summary: {
        company_name: 'Acme Corp',
        project_name: 'Project Falcon',
      },
    } as never);
    vi.mocked(companyService.findByNameFuzzy).mockResolvedValue(
      makeCompany({ id: 'company-outbound', target: 'Acme Corp', source: 'outbound' }) as never,
    );
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ id: 'company-outbound', target: 'Acme Corp', source: 'outbound' }),
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
      'company-outbound',
      expect.objectContaining({
        target: 'Acme Corp',
        project_name: 'Project Falcon',
        source: 'outbound',
      }),
      'merged_from_email_attachment:file-1',
    );
    expect(companyService.createFromDTO).not.toHaveBeenCalled();
  });

  it('does not write a generic company_name to target when merging into an existing company', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'prospectus',
      matched_companies: [{ id: 'company-existing', type: 'company' }],
      prospectus_summary: {
        company_name: 'Company Overview',
        project_name: 'Project Atlas',
        segment: 'Fintech',
      },
    } as never);
    vi.mocked(companyService.findById).mockResolvedValue(
      makeCompany({ id: 'company-existing', target: 'Real Name Corp' }),
    );

    await service.processUpload(
      'uploads/teaser.pdf',
      'teaser.pdf',
      'application/pdf',
      undefined,
      undefined,
      true,
    );

    const updates = vi.mocked(companyService.updateFromDTO).mock.calls[0]?.[1] as Record<string, unknown>;
    expect(updates.target).toBeUndefined();
    expect(updates.project_name).toBe('Project Atlas');
    expect(updates.segment).toBe('Fintech');
    expect(companyService.createFromDTO).not.toHaveBeenCalled();
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
