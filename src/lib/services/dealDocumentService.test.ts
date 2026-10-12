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
    is_featured: false,
    ...overrides,
  } as DealDocument;
}

function makeRepoStub(): DealDocumentRepository {
  return {
    findById: vi.fn(),
    findPathAndNameById: vi.fn(),
    findFeaturedByDealId: vi.fn().mockResolvedValue(null),
    clearFeaturedByDealId: vi.fn(),
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

  it('does not clear any featured document when registering a non-featured upload', async () => {
    const repo = makeRepoStub();
    const jobDispatcher = makeJobDispatcherStub();
    vi.mocked(repo.insert).mockResolvedValue(makeDocument());
    const service = new DealDocumentService(repo, jobDispatcher, 'workspace-1');

    await service.register({
      deal_id: 'company-1',
      file_name: 'report.pdf',
      file_path: 'uploads/deals/report.pdf',
      stage: 'L1',
    });

    expect(repo.clearFeaturedByDealId).not.toHaveBeenCalled();
  });

  it('unfeatures the previous featured document (without deleting it) before registering a new featured upload', async () => {
    const repo = makeRepoStub();
    const jobDispatcher = makeJobDispatcherStub();
    vi.mocked(repo.insert).mockResolvedValue(makeDocument({ id: 'doc-new', is_featured: true }));
    const service = new DealDocumentService(repo, jobDispatcher, 'workspace-1');

    await service.register({
      deal_id: 'company-1',
      file_name: 'new.pdf',
      file_path: 'uploads/deals/new.pdf',
      stage: 'L1',
      is_featured: true,
    });

    expect(repo.clearFeaturedByDealId).toHaveBeenCalledWith('company-1');
    expect(deleteFile).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ file_name: 'new.pdf', is_featured: true }),
    );
  });

  it('clears before inserting (order preserved) so the unique index never sees two featured rows', async () => {
    const repo = makeRepoStub();
    const jobDispatcher = makeJobDispatcherStub();
    const callOrder: string[] = [];
    vi.mocked(repo.clearFeaturedByDealId).mockImplementation(async () => { callOrder.push('clear'); });
    vi.mocked(repo.insert).mockImplementation(async () => { callOrder.push('insert'); return makeDocument({ is_featured: true }); });
    const service = new DealDocumentService(repo, jobDispatcher, 'workspace-1');

    await service.register({
      deal_id: 'company-1',
      file_name: 'new.pdf',
      file_path: 'uploads/deals/new.pdf',
      stage: 'L1',
      is_featured: true,
    });

    expect(callOrder).toEqual(['clear', 'insert']);
  });

  it('rejects a featured upload that is not a PDF or PPTX', async () => {
    const repo = makeRepoStub();
    const jobDispatcher = makeJobDispatcherStub();
    const service = new DealDocumentService(repo, jobDispatcher, 'workspace-1');

    await expect(
      service.register({
        deal_id: 'company-1',
        file_name: 'notes.docx',
        file_path: 'uploads/deals/notes.docx',
        stage: 'L1',
        is_featured: true,
      }),
    ).rejects.toThrow(/PDF or PPTX/);
    expect(repo.clearFeaturedByDealId).not.toHaveBeenCalled();
    expect(repo.insert).not.toHaveBeenCalled();
  });
});

describe('DealDocumentService.setFeatured', () => {
  it('unfeatures the current featured document, then features the given one', async () => {
    const repo = makeRepoStub();
    const jobDispatcher = makeJobDispatcherStub();
    const callOrder: string[] = [];
    vi.mocked(repo.findById).mockResolvedValue(makeDocument({ id: 'doc-existing', deal_id: 'company-1' }));
    vi.mocked(repo.clearFeaturedByDealId).mockImplementation(async () => { callOrder.push('clear'); });
    vi.mocked(repo.updatePartial).mockImplementation(async () => { callOrder.push('update'); });
    const service = new DealDocumentService(repo, jobDispatcher, 'workspace-1');

    await service.setFeatured('company-1', 'doc-existing');

    expect(repo.clearFeaturedByDealId).toHaveBeenCalledWith('company-1');
    expect(repo.updatePartial).toHaveBeenCalledWith('doc-existing', { is_featured: true });
    expect(callOrder).toEqual(['clear', 'update']);
  });

  it('rejects a document that belongs to a different deal without changing featured state', async () => {
    const repo = makeRepoStub();
    const jobDispatcher = makeJobDispatcherStub();
    vi.mocked(repo.findById).mockResolvedValue(
      makeDocument({ id: 'doc-other', deal_id: 'company-2', file_name: 'deck.pptx' }),
    );
    const service = new DealDocumentService(repo, jobDispatcher, 'workspace-1');

    await expect(service.setFeatured('company-1', 'doc-other')).rejects.toThrow(
      /does not belong to this deal/,
    );
    expect(repo.clearFeaturedByDealId).not.toHaveBeenCalled();
    expect(repo.updatePartial).not.toHaveBeenCalled();
  });

  it('rejects a document that is not a PDF or PPTX', async () => {
    const repo = makeRepoStub();
    const jobDispatcher = makeJobDispatcherStub();
    vi.mocked(repo.findById).mockResolvedValue(makeDocument({ file_name: 'notes.docx' }));
    const service = new DealDocumentService(repo, jobDispatcher, 'workspace-1');

    await expect(service.setFeatured('company-1', 'doc-1')).rejects.toThrow(/PDF or PPTX/);
    expect(repo.clearFeaturedByDealId).not.toHaveBeenCalled();
  });
});

describe('DealDocumentService.clearFeatured', () => {
  it('unfeatures the deal\'s current featured slide without deleting anything', async () => {
    const repo = makeRepoStub();
    const jobDispatcher = makeJobDispatcherStub();
    const service = new DealDocumentService(repo, jobDispatcher, 'workspace-1');

    await service.clearFeatured('company-1');

    expect(repo.clearFeaturedByDealId).toHaveBeenCalledWith('company-1');
    expect(repo.delete).not.toHaveBeenCalled();
    expect(deleteFile).not.toHaveBeenCalled();
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

describe('DealDocumentService.register backdating', () => {
  it('stamps created_at when the timeline composer backdated the upload', async () => {
    const repo = makeRepoStub();
    const jobDispatcher = makeJobDispatcherStub();
    vi.mocked(repo.insert).mockResolvedValue(makeDocument());
    const service = new DealDocumentService(repo, jobDispatcher, 'workspace-1');

    await service.register({
      deal_id: 'company-1',
      file_name: 'report.pdf',
      file_path: 'uploads/deals/report.pdf',
      stage: 'L1',
      created_at: '2026-10-09T14:30:00Z',
    });

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ created_at: '2026-10-09T14:30:00.000Z' }),
    );
  });

  it('drops a null created_at so the column default stamps the row', async () => {
    const repo = makeRepoStub();
    const jobDispatcher = makeJobDispatcherStub();
    vi.mocked(repo.insert).mockResolvedValue(makeDocument());
    const service = new DealDocumentService(repo, jobDispatcher, 'workspace-1');

    await service.register({
      deal_id: 'company-1',
      file_name: 'report.pdf',
      file_path: 'uploads/deals/report.pdf',
      stage: 'L1',
      created_at: null,
    });

    expect(repo.insert).toHaveBeenCalledWith(
      expect.not.objectContaining({ created_at: expect.anything() }),
    );
  });

  it('rejects an unparseable created_at rather than silently stamping now', async () => {
    const repo = makeRepoStub();
    const jobDispatcher = makeJobDispatcherStub();
    const service = new DealDocumentService(repo, jobDispatcher, 'workspace-1');

    await expect(
      service.register({
        deal_id: 'company-1',
        file_name: 'report.pdf',
        file_path: 'uploads/deals/report.pdf',
        stage: 'L1',
        created_at: 'last tuesday',
      }),
    ).rejects.toThrow();
    expect(repo.insert).not.toHaveBeenCalled();
  });
});
