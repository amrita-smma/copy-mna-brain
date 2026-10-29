import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runFundUpdateExtraction } from './fundUpdateExtraction';
import type { Tables } from '@/lib/repositories';
import { tryDeterministicFundUpdateParse } from '@/lib/fund_updates';

const liveMocks = vi.hoisted(() => ({ publishLiveEvent: vi.fn() }));
vi.mock('@/lib/server/liveEvents', () => ({ publishLiveEvent: liveMocks.publishLiveEvent }));

// Mock dependencies
vi.mock('@/lib/s3', () => ({
  downloadFile: vi.fn().mockResolvedValue(Buffer.from('mock-excel-binary')),
}));

vi.mock('@/lib/fund_updates', () => ({
  tryDeterministicFundUpdateParse: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/lib/agents/fund_update_processing/orchestrateFallback', () => ({
  orchestrateWorkbookFallback: vi.fn().mockResolvedValue({
    file_type: 'fund_updates',
    parser: 'workbook_fallback_v1',
    summary: 'Extracted 10 events across 3 entities.',
    key_points: [],
    action_items: [],
    tags: ['Fund Update', 'Fund I'],
    companies_detected: ['Entity A'],
    company_notes: [],
    file_date: null,
    suggested_track_ids: [],
    matched_companies: [],
    fund_update_proposal: {
      template_id: 'workbook_fallback_v1',
      schema_version: 'workbook_fallback_v1',
      stats: {
        asset_count: 1,
        direct_count: 1,
        fund_of_funds_count: 0,
        transaction_count: 1,
        valuation_count: 0,
        total_data_rows: 10,
        parsed_rows_count: 10,
        excluded_rows_count: 0,
        ambiguous_rows_count: 0,
        coverage_pct: 100,
        entity_count: 1,
        event_count: 1,
      },
      entities: [],
      events: [],
      valuations: [],
      row_accounting: {
        totalDataRows: 10,
        parsedRows: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        excludedRows: [],
        ambiguousRows: [],
        coveragePct: 100,
        unaccountedRows: [],
      },
      warnings: [],
      reconciliation: [],
      validation: {
        isReviewable: true,
        hardFailures: [],
        warnings: [],
        stats: {} as any,
      },
      assets: [],
    },
  }),
}));

describe('fundUpdateExtraction job handler', () => {
  let mockFile: any;
  let mockFileRepo: any;
  let mockJobRepo: any;
  let mockDb: any;
  let mockJob: Tables<'jobs'>;

  beforeEach(() => {
    mockFile = {
      id: 'file-123',
      file_name: 'test_ledger.xlsx',
      file_link: 'files/test_ledger.xlsx',
      workspace_id: 'ws-1',
      processing_status: 'pending',
    };

    mockFileRepo = {
      findById: vi.fn().mockResolvedValue(mockFile),
      updatePartial: vi.fn().mockResolvedValue(mockFile),
    };

    mockJobRepo = {
      appendLog: vi.fn().mockResolvedValue(undefined),
    };

    mockDb = {};
    liveMocks.publishLiveEvent.mockReset().mockResolvedValue(undefined);
    mockJob = {
      id: 'job-999',
      type: 'fund_update_extraction' as any,
      status: 'running',
      workspace_id: 'ws-1',
      payload: { fileId: 'file-123' },
      result: null,
      error: null,
      timeout_seconds: 600,
      started_at: new Date().toISOString(),
      completed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  });

  it('downloads file, runs fallback orchestrator, and updates file with structured proposal', async () => {
    // Intercept FileRepository and JobRepository instantiation
    const { FileRepository, JobRepository } = await import('@/lib/repositories');
    vi.spyOn(FileRepository.prototype, 'findById').mockImplementation(mockFileRepo.findById);
    vi.spyOn(FileRepository.prototype, 'updatePartial').mockImplementation(mockFileRepo.updatePartial);
    vi.spyOn(JobRepository.prototype, 'appendLog').mockImplementation(mockJobRepo.appendLog);

    const result = await runFundUpdateExtraction(
      { fileId: 'file-123', workspaceId: 'ws-1' },
      { db: mockDb, job: mockJob },
    );

    expect(mockFileRepo.findById).toHaveBeenCalledWith('file-123');
    expect(mockFileRepo.updatePartial).toHaveBeenCalledWith(
      'file-123',
      expect.objectContaining({
        processing_status: 'awaiting_review',
        file_type: 'fund_updates',
      }),
    );
    expect(mockJobRepo.appendLog).toHaveBeenCalledWith(
      'job-999',
      expect.objectContaining({ message: 'Starting fund update extraction' }),
    );
    expect(mockJobRepo.appendLog).toHaveBeenCalledWith(
      'job-999',
      expect.objectContaining({ message: expect.stringContaining('Extraction completed successfully') }),
    );

    expect((result.fund_update_proposal as any)?.schema_version).toBe('workbook_fallback_v1');
    // Smart Files hears the row move to processing, then to awaiting_review.
    expect(liveMocks.publishLiveEvent).toHaveBeenCalledTimes(2);
    expect(liveMocks.publishLiveEvent).toHaveBeenCalledWith('ws-1', 'files', ['file-123']);
    expect(liveMocks.publishLiveEvent.mock.invocationCallOrder[1]).toBeGreaterThan(
      mockFileRepo.updatePartial.mock.invocationCallOrder[1],
    );
  });

  it('reparses Nanjing workbooks with existing master investor names', async () => {
    const { FileRepository, FlInvestorRepository, JobRepository } = await import('@/lib/repositories');
    vi.spyOn(FileRepository.prototype, 'findById').mockImplementation(mockFileRepo.findById);
    vi.spyOn(FileRepository.prototype, 'updatePartial').mockImplementation(mockFileRepo.updatePartial);
    vi.spyOn(JobRepository.prototype, 'appendLog').mockImplementation(mockJobRepo.appendLog);
    vi.spyOn(FlInvestorRepository.prototype, 'findByWorkspaceId').mockResolvedValue([
      { name: 'Existing Transferor' } as Tables<'fl_investors'>,
    ]);

    const nanjingResult = {
      file_type: 'fund_updates',
      parser: 'nanjing_fund_ledger_v1',
      summary: 'Nanjing ledger',
      key_points: [],
      action_items: [],
      tags: [],
      companies_detected: [],
      company_notes: [],
      file_date: null,
      suggested_track_ids: [],
      matched_companies: [],
      fund_update_proposal: { assets: [], stats: { asset_count: 0 } },
    } as any;
    vi.mocked(tryDeterministicFundUpdateParse)
      .mockClear()
      .mockResolvedValueOnce(nanjingResult)
      .mockResolvedValueOnce(nanjingResult);

    await runFundUpdateExtraction(
      { fileId: 'file-123', workspaceId: 'ws-1' },
      { db: mockDb, job: mockJob },
    );

    expect(tryDeterministicFundUpdateParse).toHaveBeenCalledTimes(2);
    expect(tryDeterministicFundUpdateParse).toHaveBeenLastCalledWith(
      expect.any(Buffer),
      expect.any(String),
      'test_ledger.xlsx',
      { knownMasterInvestors: ['Existing Transferor'] },
    );
  });

  it('marks file as failed when extraction has critical validation failures', async () => {
    const { orchestrateWorkbookFallback } = await import(
      '@/lib/agents/fund_update_processing/orchestrateFallback'
    );
    vi.mocked(orchestrateWorkbookFallback).mockResolvedValueOnce({
      file_type: 'fund_updates',
      parser: 'workbook_fallback_v1',
      summary: 'Extraction failed reviewability.',
      key_points: [],
      action_items: [],
      tags: [],
      companies_detected: [],
      company_notes: [],
      file_date: null,
      suggested_track_ids: [],
      matched_companies: [],
      fund_update_proposal: {
        template_id: 'workbook_fallback_v1',
        schema_version: 'workbook_fallback_v1',
        stats: {} as any,
        entities: [],
        events: [],
        valuations: [],
        row_accounting: {} as any,
        interpretation: {} as any,
        warnings: [],
        reconciliation: [],
        validation: {
          isReviewable: false,
          hardFailures: ['Coverage is too low: only 4 rows parsed out of 205'],
          warnings: [],
          stats: {} as any,
        },
        assets: [],
      },
    });

    const { FileRepository, JobRepository } = await import('@/lib/repositories');
    vi.spyOn(FileRepository.prototype, 'findById').mockImplementation(mockFileRepo.findById);
    vi.spyOn(FileRepository.prototype, 'updatePartial').mockImplementation(mockFileRepo.updatePartial);
    vi.spyOn(JobRepository.prototype, 'appendLog').mockImplementation(mockJobRepo.appendLog);

    await runFundUpdateExtraction(
      { fileId: 'file-123', workspaceId: 'ws-1' },
      { db: mockDb, job: mockJob },
    );

    expect(mockFileRepo.updatePartial).toHaveBeenCalledWith(
      'file-123',
      expect.objectContaining({
        processing_status: 'failed',
      }),
    );
    expect(mockJobRepo.appendLog).toHaveBeenCalledWith(
      'job-999',
      expect.objectContaining({
        message: expect.stringContaining('Extraction completed with hard validation failures'),
      }),
    );
  });

  it('marks file as failed and appends failure job log on download error before rethrowing', async () => {
    const { downloadFile } = await import('@/lib/s3');
    vi.mocked(downloadFile).mockRejectedValueOnce(new Error('S3 connection timed out'));

    const { FileRepository, JobRepository } = await import('@/lib/repositories');
    vi.spyOn(FileRepository.prototype, 'findById').mockImplementation(mockFileRepo.findById);
    vi.spyOn(FileRepository.prototype, 'updatePartial').mockImplementation(mockFileRepo.updatePartial);
    vi.spyOn(JobRepository.prototype, 'appendLog').mockImplementation(mockJobRepo.appendLog);

    await expect(
      runFundUpdateExtraction(
        { fileId: 'file-123', workspaceId: 'ws-1' },
        { db: mockDb, job: mockJob },
      ),
    ).rejects.toThrow('S3 connection timed out');

    expect(mockFileRepo.updatePartial).toHaveBeenCalledWith(
      'file-123',
      expect.objectContaining({ processing_status: 'failed' }),
    );
    expect(mockJobRepo.appendLog).toHaveBeenCalledWith(
      'job-999',
      expect.objectContaining({
        message: expect.stringContaining('Fund update extraction failed: S3 connection timed out'),
      }),
    );
  });

  it('marks file as failed and appends failure job log on fallback LLM error before rethrowing', async () => {
    const { orchestrateWorkbookFallback } = await import(
      '@/lib/agents/fund_update_processing/orchestrateFallback'
    );
    vi.mocked(orchestrateWorkbookFallback).mockRejectedValueOnce(new Error('LLM rate limit exceeded'));

    const { FileRepository, JobRepository } = await import('@/lib/repositories');
    vi.spyOn(FileRepository.prototype, 'findById').mockImplementation(mockFileRepo.findById);
    vi.spyOn(FileRepository.prototype, 'updatePartial').mockImplementation(mockFileRepo.updatePartial);
    vi.spyOn(JobRepository.prototype, 'appendLog').mockImplementation(mockJobRepo.appendLog);

    await expect(
      runFundUpdateExtraction(
        { fileId: 'file-123', workspaceId: 'ws-1' },
        { db: mockDb, job: mockJob },
      ),
    ).rejects.toThrow('LLM rate limit exceeded');

    expect(mockFileRepo.updatePartial).toHaveBeenCalledWith(
      'file-123',
      expect.objectContaining({ processing_status: 'failed' }),
    );
    expect(mockJobRepo.appendLog).toHaveBeenCalledWith(
      'job-999',
      expect.objectContaining({
        message: expect.stringContaining('Fund update extraction failed: LLM rate limit exceeded'),
      }),
    );
  });

  it('passes payload.contentType through to tryDeterministicFundUpdateParse and orchestrateWorkbookFallback', async () => {
    const { tryDeterministicFundUpdateParse } = await import('@/lib/fund_updates');
    const { orchestrateWorkbookFallback } = await import(
      '@/lib/agents/fund_update_processing/orchestrateFallback'
    );
    const { FileRepository, JobRepository } = await import('@/lib/repositories');
    vi.spyOn(FileRepository.prototype, 'findById').mockImplementation(mockFileRepo.findById);
    vi.spyOn(FileRepository.prototype, 'updatePartial').mockImplementation(mockFileRepo.updatePartial);
    vi.spyOn(JobRepository.prototype, 'appendLog').mockImplementation(mockJobRepo.appendLog);

    await runFundUpdateExtraction(
      {
        fileId: 'file-123',
        workspaceId: 'ws-1',
        contentType: 'application/vnd.ms-excel.custom',
      },
      { db: mockDb, job: mockJob },
    );

    expect(tryDeterministicFundUpdateParse).toHaveBeenCalledWith(
      expect.any(Buffer),
      'application/vnd.ms-excel.custom',
      'test_ledger.xlsx',
    );
    expect(orchestrateWorkbookFallback).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: 'application/vnd.ms-excel.custom',
      }),
    );
  });

  it('infers macro-enabled content type for .xlsm files when payload contentType is omitted', async () => {
    const { tryDeterministicFundUpdateParse } = await import('@/lib/fund_updates');
    mockFile.file_name = 'fund_model.xlsm';

    const { FileRepository, JobRepository } = await import('@/lib/repositories');
    vi.spyOn(FileRepository.prototype, 'findById').mockImplementation(mockFileRepo.findById);
    vi.spyOn(FileRepository.prototype, 'updatePartial').mockImplementation(mockFileRepo.updatePartial);
    vi.spyOn(JobRepository.prototype, 'appendLog').mockImplementation(mockJobRepo.appendLog);

    await runFundUpdateExtraction(
      { fileId: 'file-123', workspaceId: 'ws-1' },
      { db: mockDb, job: mockJob },
    );

    expect(tryDeterministicFundUpdateParse).toHaveBeenCalledWith(
      expect.any(Buffer),
      'application/vnd.ms-excel.sheet.macroenabled.12',
      'fund_model.xlsm',
    );
  });

  it('infers binary excel content type for legacy .xls files when payload contentType is omitted', async () => {
    const { tryDeterministicFundUpdateParse } = await import('@/lib/fund_updates');
    mockFile.file_name = 'legacy_report.xls';

    const { FileRepository, JobRepository } = await import('@/lib/repositories');
    vi.spyOn(FileRepository.prototype, 'findById').mockImplementation(mockFileRepo.findById);
    vi.spyOn(FileRepository.prototype, 'updatePartial').mockImplementation(mockFileRepo.updatePartial);
    vi.spyOn(JobRepository.prototype, 'appendLog').mockImplementation(mockJobRepo.appendLog);

    await runFundUpdateExtraction(
      { fileId: 'file-123', workspaceId: 'ws-1' },
      { db: mockDb, job: mockJob },
    );

    expect(tryDeterministicFundUpdateParse).toHaveBeenCalledWith(
      expect.any(Buffer),
      'application/vnd.ms-excel',
      'legacy_report.xls',
    );
  });
});
