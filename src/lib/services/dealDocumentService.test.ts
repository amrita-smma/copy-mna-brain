import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DealDocumentRepository, Tables } from '@/lib/repositories';
import type { JobDispatcher } from './jobDispatcher';
import { DealDocumentService } from './dealDocumentService';

vi.mock('@/lib/s3', () => ({ deleteFile: vi.fn() }));

import { deleteFile } from '@/lib/s3';

afterEach(() => vi.clearAllMocks());

type DealDocument = Tables<'deal_documents'>;

function makeDocument(overrides: Partial<DealDocument> = {}): DealDocument {
  return {
    id: 'doc-1',
    deal_id: 'company-1',
    file_name: 'report.pdf',
    file_path: 'uploads/deals/report.pdf',
    file_size: 1024,
    mime_type: 'application/pdf',
    stage: 'L1',
    created_at: new Date().toISOString(),
    raw_notes: null,
    structured_notes: null,
    tags: [],
    processing_status: 'pending',
    ...overrides,
  } as DealDocument;
}

function makeRepoStub(): DealDocumentRepository {
  return {
    findById: vi.fn(),
    findPathAndNameById: vi.fn(),
    findFilePathsByDealId: vi.fn(),
    insert: vi.fn(),
    updatePartial: vi.fn(),
    delete: vi.fn(),
  } as unknown as DealDocumentRepository;
}

function makeJobDispatcherStub(): JobDispatcher {
  return {
    dispatch: vi.fn().mockResolvedValue({ jobId: 'job-1' }),
  } as unknown as JobDispatcher;
}

describe('DealDocumentService.register', () => {
  it('inserts the document then dispatches a deal_document_processing job', async () => {
    const repo = makeRepoStub();
    const jobDispatcher = makeJobDispatcherStub();
    const row = makeDocument();
    vi.mocked(repo.insert).mockResolvedValue(row);
    const service = new DealDocumentService(repo, jobDispatcher, 'workspace-1');

    const result = await service.register({
      deal_id: 'company-1',
      file_name: 'report.pdf',
      file_path: 'uploads/deals/report.pdf',
      file_size: 1024,
      mime_type: 'application/pdf',
      stage: 'L1',
    });

    expect(result).toEqual(row);
    expect(repo.insert).toHaveBeenCalledWith({
      deal_id: 'company-1',
      file_name: 'report.pdf',
      file_path: 'uploads/deals/report.pdf',
      file_size: 1024,
      mime_type: 'application/pdf',
      stage: 'L1',
    });
    expect(jobDispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'deal_document_processing',
        payload: { dealDocumentId: 'doc-1', workspaceId: 'workspace-1', contentType: 'application/pdf' },
      }),
    );
  });
});

describe('DealDocumentService.delete', () => {
  it('deletes the S3 file then removes the DB record', async () => {
    const repo = makeRepoStub();
    const jobDispatcher = makeJobDispatcherStub();
    vi.mocked(repo.findById).mockResolvedValue(makeDocument());
    const service = new DealDocumentService(repo, jobDispatcher, 'workspace-1');

    await service.delete('doc-1');

    expect(deleteFile).toHaveBeenCalledWith('uploads/deals/report.pdf');
    expect(repo.delete).toHaveBeenCalledWith('doc-1');
  });

  it('deletes S3 before the DB record (order preserved)', async () => {
    const repo = makeRepoStub();
    const jobDispatcher = makeJobDispatcherStub();
    vi.mocked(repo.findById).mockResolvedValue(makeDocument());
    const callOrder: string[] = [];
    vi.mocked(deleteFile).mockImplementation(async () => { callOrder.push('s3'); });
    vi.mocked(repo.delete).mockImplementation(async () => { callOrder.push('db'); });
    const service = new DealDocumentService(repo, jobDispatcher, 'workspace-1');

    await service.delete('doc-1');

    expect(callOrder).toEqual(['s3', 'db']);
  });
});
