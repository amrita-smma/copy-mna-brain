import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  listDistinctNeedsExtractHashes: vi.fn(),
  findDoneByHash: vi.fn(),
  markExtracted: vi.fn(),
  markFailed: vi.fn(),
  downloadFile: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('../repositories', () => ({
  EmailAttachmentRepository: class {
    listDistinctNeedsExtractHashes = mocks.listDistinctNeedsExtractHashes;
    findDoneByHash = mocks.findDoneByHash;
    markExtracted = mocks.markExtracted;
    markFailed = mocks.markFailed;
  },
}));

vi.mock('@/lib/s3', () => ({
  downloadFile: mocks.downloadFile,
}));

// Patch global fetch
vi.stubGlobal('fetch', mocks.fetch);

import { runAttachmentUpload } from './attachmentUpload';

function makeJob() { return { id: 'job-1' } as never; }

function makeGroup(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    content_hash: 'abc123def456',
    doc_type: 'im',
    s3_key: 'attachments/abc123def456.pdf',
    s3_bucket: 'mbox-archive',
    banker_source: null,
    ids: ['att-1'],
    ...overrides,
  };
}

function makeJsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  };
}

describe('runAttachmentUpload', () => {
  function setupHappyFetch(key = 'meeting-notes/abc.pdf') {
    mocks.fetch
      .mockResolvedValueOnce(makeJsonResponse({ data: { uploadUrl: 'https://s3.example.com/upload', key } }))
      .mockResolvedValueOnce(makeJsonResponse({}))
      .mockResolvedValueOnce(makeJsonResponse({ success: true, data: {} }));
  }

  beforeEach(() => {
    Object.values(mocks).forEach((m) => {
      if (typeof m === 'function' && 'mockReset' in m) (m as ReturnType<typeof vi.fn>).mockReset();
    });
    mocks.markExtracted.mockResolvedValue(undefined);
    mocks.markFailed.mockResolvedValue(undefined);
    mocks.findDoneByHash.mockResolvedValue(null);
    mocks.downloadFile.mockResolvedValue(Buffer.alloc(1000));
  });

  it('returns early when nothing to upload', async () => {
    mocks.listDistinctNeedsExtractHashes.mockResolvedValue([]);
    const result = await runAttachmentUpload({}, { db: {} as never, job: makeJob() });
    expect(result).toEqual({ evaluated: 0, uploaded: 0, failed: 0 });
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('uploads a PDF and marks done', async () => {
    setupHappyFetch();
    mocks.listDistinctNeedsExtractHashes.mockResolvedValue([makeGroup()]);

    const result = await runAttachmentUpload({}, { db: {} as never, job: makeJob() });

    expect(result.uploaded).toBe(1);
    expect(mocks.fetch).toHaveBeenCalledTimes(3); // presign, PUT, notify
    expect(mocks.markExtracted).toHaveBeenCalledWith(
      ['att-1'],
      expect.objectContaining({ afd_key: 'meeting-notes/abc.pdf' }),
    );
  });

  it('does NOT pass file_type_override for im/prospectus/teaser — lets AFD classify', async () => {
    setupHappyFetch('k');
    mocks.listDistinctNeedsExtractHashes.mockResolvedValue([makeGroup({ doc_type: 'im' })]);

    await runAttachmentUpload({}, { db: {} as never, job: makeJob() });

    const notifyCall = mocks.fetch.mock.calls[2];
    const body = JSON.parse(notifyCall[1].body as string);
    expect(body.file_type_override).toBeUndefined();
    expect(body.origin_email).toBe(true);
  });

  it('passes file_type_override for mom', async () => {
    setupHappyFetch('k');
    mocks.listDistinctNeedsExtractHashes.mockResolvedValue([makeGroup({ doc_type: 'mom' })]);

    await runAttachmentUpload({}, { db: {} as never, job: makeJob() });

    const notifyCall = mocks.fetch.mock.calls[2];
    const body = JSON.parse(notifyCall[1].body as string);
    expect(body.file_type_override).toBe('mom');
  });

  it('passes file_type_override for shopping_list and market_study', async () => {
    for (const docType of ['shopping_list', 'market_study']) {
      mocks.fetch
        .mockResolvedValueOnce(makeJsonResponse({ data: { uploadUrl: 'https://s3/upload', key: 'k' } }))
        .mockResolvedValueOnce(makeJsonResponse({}))
        .mockResolvedValueOnce(makeJsonResponse({ success: true, data: {} }));
      mocks.listDistinctNeedsExtractHashes.mockResolvedValue([makeGroup({ doc_type: docType })]);

      await runAttachmentUpload({}, { db: {} as never, job: makeJob() });

      const calls = mocks.fetch.mock.calls;
      const body = JSON.parse(calls[calls.length - 1][1].body as string);
      expect(body.file_type_override).toBe(docType);
      vi.clearAllMocks();
      mocks.markExtracted.mockResolvedValue(undefined);
      mocks.markFailed.mockResolvedValue(undefined);
      mocks.downloadFile.mockResolvedValue(Buffer.alloc(1000));
    }
  });

  it('marks failed and continues when upload errors', async () => {
    const group1 = makeGroup({ content_hash: 'hash1', ids: ['att-1'] });
    const group2 = makeGroup({ content_hash: 'hash2', ids: ['att-2'] });
    mocks.listDistinctNeedsExtractHashes.mockResolvedValue([group1, group2]);

    // First doc: presign OK, PUT fails
    mocks.fetch
      .mockResolvedValueOnce(makeJsonResponse({ data: { uploadUrl: 'https://s3/upload', key: 'k1' } }))
      .mockResolvedValueOnce(makeJsonResponse({}, 500))
      // Second doc: all succeed
      .mockResolvedValueOnce(makeJsonResponse({ data: { uploadUrl: 'https://s3/upload2', key: 'k2' } }))
      .mockResolvedValueOnce(makeJsonResponse({}))
      .mockResolvedValueOnce(makeJsonResponse({ success: true, data: {} }));

    const result = await runAttachmentUpload({}, { db: {} as never, job: makeJob() });

    expect(result.failed).toBe(1);
    expect(result.uploaded).toBe(1);
    expect(mocks.markFailed).toHaveBeenCalledWith('att-1', expect.stringContaining('S3 PUT failed'));
  });

  it('uses real filename with type prefix and correct MIME for PPTX', async () => {
    // Regression test: PPTX must not be sent as application/pdf
    setupHappyFetch('k');
    mocks.listDistinctNeedsExtractHashes.mockResolvedValue([makeGroup({
      doc_type: null,
      mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      filename: 'Deal Teaser v3.pptx',
    })]);

    await runAttachmentUpload({}, { db: {} as never, job: makeJob() });

    // presigned URL request must use the real content type
    const presignCall = mocks.fetch.mock.calls[0];
    expect(presignCall[0]).toContain('contentType=application%2Fvnd.openxmlformats');

    // Notify body: real filename with type prefix, correct content type
    const notifyCall = mocks.fetch.mock.calls[2];
    const body = JSON.parse(notifyCall[1].body as string);
    expect(body.fileName).toBe('attachment_Deal Teaser v3.pptx');
    expect(body.contentType).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(body.origin_email).toBe(true);
    expect(body.file_type_override).toBeUndefined();
  });

  it('uses real filename with type prefix for PDF with known doc_type', async () => {
    setupHappyFetch('k');
    mocks.listDistinctNeedsExtractHashes.mockResolvedValue([makeGroup({
      doc_type: 'im',
      mime_type: 'application/pdf',
      filename: 'Project Advantek IM Final.pdf',
    })]);

    await runAttachmentUpload({}, { db: {} as never, job: makeJob() });

    const notifyCall = mocks.fetch.mock.calls[2];
    const body = JSON.parse(notifyCall[1].body as string);
    expect(body.fileName).toBe('im_Project Advantek IM Final.pdf');
    expect(body.contentType).toBe('application/pdf');
  });

  it('always includes origin_email tag', async () => {
    setupHappyFetch();
    mocks.listDistinctNeedsExtractHashes.mockResolvedValue([makeGroup()]);

    await runAttachmentUpload({}, { db: {} as never, job: makeJob() });

    const notifyCall = mocks.fetch.mock.calls[2];
    const body = JSON.parse(notifyCall[1].body as string);
    expect(body.origin_email).toBe(true);
  });

  it('passes banker_source when attachment metadata has one', async () => {
    setupHappyFetch();
    mocks.listDistinctNeedsExtractHashes.mockResolvedValue([
      makeGroup({ banker_source: 'Goldman Sachs' }),
    ]);

    await runAttachmentUpload({}, { db: {} as never, job: makeJob() });

    const notifyCall = mocks.fetch.mock.calls[2];
    const body = JSON.parse(notifyCall[1].body as string);
    expect(body.banker_source).toBe('Goldman Sachs');
  });
});
