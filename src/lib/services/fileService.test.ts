import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileRepository, CriteriaRepository, ScreeningRepository, CompanyFinancialRepository, DbClient, Tables } from '@/lib/repositories';
import type { CompanyAnalysisService } from './companyAnalysisService';
import type { AIScreeningService } from './aiScreeningService';
import { FileService } from './fileService';

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

function makeService(overrides: {
  fileRepo?: FileRepository;
  companyAnalysisService?: CompanyAnalysisService;
  aiScreeningService?: AIScreeningService;
  criteriaRepo?: CriteriaRepository;
  screeningRepo?: ScreeningRepository;
  companyFinancialRepo?: CompanyFinancialRepository;
} = {}) {
  return new FileService(
    null as unknown as DbClient,
    overrides.fileRepo ?? makeFileRepoStub(),
    overrides.companyAnalysisService ?? makeCompanyAnalysisServiceStub(),
    overrides.aiScreeningService ?? makeAIScreeningServiceStub(),
    overrides.criteriaRepo ?? makeCriteriaRepoStub(),
    overrides.screeningRepo ?? makeScreeningRepoStub(),
    overrides.companyFinancialRepo ?? makeCompanyFinancialRepoStub(),
  );
}

describe('FileService.processUpload', () => {
  let fileRepo: FileRepository;
  let companyAnalysisService: CompanyAnalysisService;
  let aiScreeningService: AIScreeningService;
  let criteriaRepo: CriteriaRepository;
  let screeningRepo: ScreeningRepository;
  let companyFinancialRepo: CompanyFinancialRepository;
  let service: FileService;

  beforeEach(() => {
    fileRepo = makeFileRepoStub();
    companyAnalysisService = makeCompanyAnalysisServiceStub();
    aiScreeningService = makeAIScreeningServiceStub();
    criteriaRepo = makeCriteriaRepoStub();
    screeningRepo = makeScreeningRepoStub();
    companyFinancialRepo = makeCompanyFinancialRepoStub();
    service = new FileService(
      null as unknown as DbClient,
      fileRepo,
      companyAnalysisService,
      aiScreeningService,
      criteriaRepo,
      screeningRepo,
      companyFinancialRepo,
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

  it('marks status as completed when processing succeeds', async () => {
    await service.processUpload('uploads/report.pdf', 'report.pdf', 'application/pdf');

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

  it('does not dispatch company analysis when processing fails', async () => {
    vi.mocked(processFileContent).mockRejectedValue(new Error('AI error'));

    await service.processUpload('uploads/report.pdf', 'report.pdf', 'application/pdf');

    expect(companyAnalysisService.dispatch).not.toHaveBeenCalled();
  });

  it('returns signed URL with file data', async () => {
    const result = await service.processUpload('uploads/report.pdf', 'report.pdf', 'application/pdf');

    expect(getSignedUrl).toHaveBeenCalledWith('uploads/report.pdf');
    expect(result).toMatchObject({ signed_url: 'https://signed-url' });
  });

  it('returns early without dispatching when structured result has no company id', async () => {
    vi.mocked(processFileContent).mockResolvedValue({ company: { target: 'Acme' } } as never);

    await service.processUpload('uploads/report.pdf', 'report.pdf', 'application/pdf');

    expect(companyAnalysisService.dispatch).not.toHaveBeenCalled();
  });

  it('dispatches company analysis when structured result has a company id', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      company: { id: 'company-1', target: 'Acme' },
      file_type: 'im',
    } as never);
    vi.mocked(companyAnalysisService.dispatch).mockResolvedValue({ jobId: 'job-1' });

    await service.processUpload('uploads/report.pdf', 'report.pdf', 'application/pdf');

    expect(companyAnalysisService.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1' }),
    );
  });

  it('inserts a screening row and dispatches AI screening for each criterion', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      company: { id: 'company-1', target: 'Acme' },
    } as never);
    vi.mocked(companyAnalysisService.dispatch).mockResolvedValue({ jobId: 'job-1' });
    vi.mocked(criteriaRepo.findAll).mockResolvedValue([
      makeCriteria('criteria-1'),
      makeCriteria('criteria-2'),
    ]);
    vi.mocked(screeningRepo.insert).mockResolvedValueOnce(makeScreening('screening-1'));
    vi.mocked(screeningRepo.insert).mockResolvedValueOnce(makeScreening('screening-2'));
    vi.mocked(aiScreeningService.dispatch).mockResolvedValue({ jobId: 'job-2' });

    await service.processUpload('uploads/report.pdf', 'report.pdf', 'application/pdf');

    await vi.waitFor(() => {
      expect(screeningRepo.insert).toHaveBeenCalledTimes(2);
      expect(aiScreeningService.dispatch).toHaveBeenCalledTimes(2);
    });
  });

  it('does not insert any screening rows when criteria list is empty', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      company: { id: 'company-1', target: 'Acme' },
    } as never);
    vi.mocked(companyAnalysisService.dispatch).mockResolvedValue({ jobId: 'job-1' });
    vi.mocked(criteriaRepo.findAll).mockResolvedValue([]);

    await service.processUpload('uploads/report.pdf', 'report.pdf', 'application/pdf');

    await vi.waitFor(() => {
      expect(screeningRepo.insert).not.toHaveBeenCalled();
    });
  });

  it('marks screening as failed when aiScreeningService.dispatch rejects', async () => {
    vi.mocked(processFileContent).mockResolvedValue({
      company: { id: 'company-1', target: 'Acme' },
    } as never);
    vi.mocked(companyAnalysisService.dispatch).mockResolvedValue({ jobId: 'job-1' });
    vi.mocked(criteriaRepo.findAll).mockResolvedValue([makeCriteria('criteria-1')]);
    vi.mocked(screeningRepo.insert).mockResolvedValue(makeScreening('screening-1'));
    vi.mocked(aiScreeningService.dispatch).mockRejectedValue(new Error('dispatch failed'));

    await service.processUpload('uploads/report.pdf', 'report.pdf', 'application/pdf');

    await vi.waitFor(() => {
      expect(screeningRepo.update).toHaveBeenCalledWith(
        'screening-1',
        expect.objectContaining({ state: 'failed' }),
      );
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
