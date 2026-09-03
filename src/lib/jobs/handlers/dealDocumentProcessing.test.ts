import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runDealDocumentProcessing } from './dealDocumentProcessing';
import type { Tables } from '@/lib/repositories';

vi.mock('@/lib/s3', () => ({
  downloadFile: vi.fn().mockResolvedValue(Buffer.from('mock-pdf-binary')),
}));

vi.mock('@/lib/fileExtractor', () => ({
  extractTextFromFile: vi.fn().mockResolvedValue('extracted raw text'),
}));

vi.mock('@/lib/agents/file_processing', () => ({
  processFileContent: vi.fn(),
}));

describe('dealDocumentProcessing job handler', () => {
  let mockDoc: any;
  let mockDealDocRepo: any;
  let mockJobRepo: any;
  let mockDb: any;
  let mockJob: Tables<'jobs'>;

  beforeEach(async () => {
    vi.clearAllMocks();

    mockDoc = {
      id: 'doc-123',
      deal_id: 'company-1',
      file_name: 'report.docx',
      file_path: 'deals/report.docx',
      mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      stage: 'L1',
      processing_status: 'pending',
    };

    mockDealDocRepo = {
      findById: vi.fn().mockResolvedValue(mockDoc),
      updatePartial: vi.fn().mockResolvedValue(undefined),
    };

    mockJobRepo = {
      appendLog: vi.fn().mockResolvedValue(undefined),
    };

    const { DealDocumentRepository, JobRepository } = await import('@/lib/repositories');
    vi.spyOn(DealDocumentRepository.prototype, 'findById').mockImplementation(mockDealDocRepo.findById);
    vi.spyOn(DealDocumentRepository.prototype, 'updatePartial').mockImplementation(mockDealDocRepo.updatePartial);
    vi.spyOn(JobRepository.prototype, 'appendLog').mockImplementation(mockJobRepo.appendLog);

    mockDb = {};
    mockJob = {
      id: 'job-999',
      type: 'deal_document_processing' as any,
      status: 'running',
      workspace_id: 'ws-1',
      payload: { dealDocumentId: 'doc-123' },
      result: null,
      error: null,
      timeout_seconds: 180,
      started_at: new Date().toISOString(),
      completed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
  });

  it('downloads, extracts, and persists structured notes/tags on success', async () => {
    const { processFileContent } = await import('@/lib/agents/file_processing');
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'mom',
      summary: 'Meeting recap.',
      key_points: ['Point A'],
      action_items: ['Follow up'],
      tags: ['acme', 'diligence'],
      companies_detected: [],
      company_notes: [],
      file_date: null,
      matched_companies: [],
    } as any);

    await runDealDocumentProcessing(
      { dealDocumentId: 'doc-123', workspaceId: 'ws-1' },
      { db: mockDb, job: mockJob },
    );

    expect(mockDealDocRepo.findById).toHaveBeenCalledWith('doc-123');
    expect(mockDealDocRepo.updatePartial).toHaveBeenCalledWith('doc-123', { processing_status: 'processing' });
    expect(mockDealDocRepo.updatePartial).toHaveBeenCalledWith(
      'doc-123',
      expect.objectContaining({
        raw_notes: 'extracted raw text',
        tags: ['acme', 'diligence'],
        processing_status: 'completed',
      }),
    );
    expect(mockJobRepo.appendLog).toHaveBeenCalledWith(
      'job-999',
      expect.objectContaining({ message: 'Document analysis completed' }),
    );
  });

  it('marks the document failed and rethrows when the agent call throws', async () => {
    const { processFileContent } = await import('@/lib/agents/file_processing');
    vi.mocked(processFileContent).mockRejectedValue(new Error('anthropic boom'));

    await expect(
      runDealDocumentProcessing({ dealDocumentId: 'doc-123', workspaceId: 'ws-1' }, { db: mockDb, job: mockJob }),
    ).rejects.toThrow('anthropic boom');

    expect(mockDealDocRepo.updatePartial).toHaveBeenCalledWith('doc-123', { processing_status: 'failed' });
    expect(mockJobRepo.appendLog).toHaveBeenCalledWith(
      'job-999',
      expect.objectContaining({ message: expect.stringContaining('Document analysis failed') }),
    );
  });

  it('skips text extraction for PDFs (extracted via the agent instead)', async () => {
    const { processFileContent } = await import('@/lib/agents/file_processing');
    const { extractTextFromFile } = await import('@/lib/fileExtractor');
    vi.mocked(processFileContent).mockResolvedValue({
      file_type: 'other',
      summary: 'PDF summary.',
      key_points: [],
      action_items: [],
      tags: [],
      companies_detected: [],
      company_notes: [],
      file_date: null,
      matched_companies: [],
    } as any);

    mockDoc.file_name = 'report.pdf';
    mockDoc.mime_type = 'application/pdf';

    await runDealDocumentProcessing(
      { dealDocumentId: 'doc-123', workspaceId: 'ws-1', contentType: 'application/pdf' },
      { db: mockDb, job: mockJob },
    );

    expect(extractTextFromFile).not.toHaveBeenCalled();
    expect(processFileContent).toHaveBeenCalledWith('', expect.any(Buffer), 'application/pdf', '', undefined, 'report.pdf');
  });

  it('marks the document failed when the agent returns no structured result', async () => {
    mockDoc.file_name = 'report.docx';
    mockDoc.mime_type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const { processFileContent } = await import('@/lib/agents/file_processing');
    vi.mocked(processFileContent).mockResolvedValue(null);

    await runDealDocumentProcessing(
      { dealDocumentId: 'doc-123', workspaceId: 'ws-1' },
      { db: mockDb, job: mockJob },
    );

    expect(mockDealDocRepo.updatePartial).toHaveBeenCalledWith(
      'doc-123',
      expect.objectContaining({ processing_status: 'failed', structured_notes: null, tags: [] }),
    );
    expect(mockJobRepo.appendLog).toHaveBeenCalledWith(
      'job-999',
      expect.objectContaining({ message: 'Document analysis produced no result' }),
    );
  });
});
