import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  streamMboxMessages: vi.fn(),
  extractRawAttachmentParts: vi.fn(),
  findById: vi.fn(),
  listNeedsFetch: vi.fn(),
  findUploadedByHash: vi.fn(),
  markFetched: vi.fn(),
  markFailed: vi.fn(),
  markDropped: vi.fn(),
  openS3GunzipStream: vi.fn(),
  uploadFile: vi.fn(),
  stripAngleBrackets: vi.fn(),
  extractEmailList: vi.fn(),
  parseMessage: vi.fn(),
  getHeader: vi.fn(),
  synthesizeMessageId: vi.fn(),
  flattenHeaders: vi.fn(),
}));

vi.mock('../mboxParser', async () => {
  const actual = await vi.importActual<typeof import('../mboxParser')>('../mboxParser');
  return {
    ...actual,
    streamMboxMessages: mocks.streamMboxMessages,
    extractRawAttachmentParts: mocks.extractRawAttachmentParts,
  };
});

vi.mock('../repositories', () => ({
  MboxFileRepository: class {
    findById = mocks.findById;
  },
  EmailAttachmentRepository: class {
    listNeedsFetch = mocks.listNeedsFetch;
    findUploadedByHash = mocks.findUploadedByHash;
    markFetched = mocks.markFetched;
    markFailed = mocks.markFailed;
    markDropped = mocks.markDropped;
  },
}));

vi.mock('../s3Stream', () => ({
  openS3GunzipStream: mocks.openS3GunzipStream,
}));

vi.mock('@/lib/s3', () => ({
  uploadFile: mocks.uploadFile,
}));

vi.mock('@/lib/services/googleVaultService', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/googleVaultService')>(
    '@/lib/services/googleVaultService',
  );
  return actual;
});

vi.mock('./vaultParse', async () => {
  const actual = await vi.importActual<typeof import('./vaultParse')>('./vaultParse');
  return {
    ...actual,
    flattenHeaders: mocks.flattenHeaders,
    synthesizeMessageId: mocks.synthesizeMessageId,
  };
});

import { runAttachmentFetch } from './attachmentFetch';

function makeJob() { return { id: 'job-1' } as never; }

function makeAttachment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'att-1',
    file_id: 'file-1',
    message_id: 'msg@test.com',
    content_hash: 'abc123',
    mime_type: 'application/pdf',
    encoding: 'base64',
    state: 'needs_fetch',
    s3_key: null,
    s3_bucket: null,
    size_bytes: null,
    ...overrides,
  };
}

function makeFile() {
  return { id: 'file-1', s3_key: 'vault/x.mbox.gz', s3_bucket: 'mbox-archive' };
}

async function* makeStream(messages: unknown[]) {
  for (const msg of messages) yield msg;
}

describe('runAttachmentFetch', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => {
      if (typeof m === 'function' && 'mockReset' in m) (m as ReturnType<typeof vi.fn>).mockReset();
    });
    mocks.uploadFile.mockResolvedValue('attachments/abc123.pdf');
    mocks.markFetched.mockResolvedValue(undefined);
    mocks.markFailed.mockResolvedValue(undefined);
    mocks.markDropped.mockResolvedValue(undefined);
    mocks.findUploadedByHash.mockResolvedValue(null);
    mocks.openS3GunzipStream.mockResolvedValue({});
    mocks.flattenHeaders.mockImplementation((headers: Record<string, string[]>) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) if (v.length > 0) out[k] = v[0];
      return out;
    });
  });

  it('returns early with nothing to do when no needs_fetch rows', async () => {
    mocks.listNeedsFetch.mockResolvedValue([]);
    const result = await runAttachmentFetch({}, { db: {} as never, job: makeJob() });
    expect(result).toEqual({ files_processed: 0, files_failed: 0, attachments_fetched: 0, attachments_deduped: 0, attachments_failed: 0 });
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it('fetches and uploads a qualifying attachment', async () => {
    const att = makeAttachment();
    const rawMsg = {
      headers: { 'message-id': ['<msg@test.com>'] },
      rawBody: '',
    };
    mocks.listNeedsFetch.mockResolvedValue([att]);
    mocks.findById.mockResolvedValue(makeFile());
    mocks.openS3GunzipStream.mockResolvedValue({});
    mocks.streamMboxMessages.mockReturnValue(makeStream([rawMsg]));
    mocks.extractRawAttachmentParts.mockReturnValue([{
      mime_type: 'application/pdf',
      encoding: 'base64',
      content_hash: 'abc123',
      body: Buffer.alloc(100).toString('base64'),
    }]);

    const result = await runAttachmentFetch({}, { db: {} as never, job: makeJob() });

    expect(result.attachments_fetched).toBe(1);
    expect(result.files_processed).toBe(1);
    expect(mocks.uploadFile).toHaveBeenCalledOnce();
    expect(mocks.markFetched).toHaveBeenCalledWith('att-1', expect.objectContaining({
      s3_bucket: 'mbox-archive',
      s3_key: 'attachments/abc123.pdf',
    }));
  });

  it('dedupes when same content_hash already uploaded', async () => {
    const att = makeAttachment();
    const existing = makeAttachment({ id: 'att-existing', s3_key: 'attachments/abc123.pdf', s3_bucket: 'mbox-archive', size_bytes: 5000, state: 'needs_triage' });
    mocks.listNeedsFetch.mockResolvedValue([att]);
    mocks.findById.mockResolvedValue(makeFile());
    mocks.findUploadedByHash.mockResolvedValue(existing);
    mocks.openS3GunzipStream.mockResolvedValue({});
    mocks.streamMboxMessages.mockReturnValue(makeStream([]));

    const result = await runAttachmentFetch({}, { db: {} as never, job: makeJob() });

    expect(result.attachments_deduped).toBe(1);
    expect(result.attachments_fetched).toBe(0);
    expect(mocks.uploadFile).not.toHaveBeenCalled();
    expect(mocks.markFetched).toHaveBeenCalledWith('att-1', {
      s3_bucket: 'mbox-archive', s3_key: 'attachments/abc123.pdf', size_bytes: 5000,
    });
  });

  it('marks failed when mbox file not found', async () => {
    mocks.listNeedsFetch.mockResolvedValue([makeAttachment()]);
    mocks.findById.mockResolvedValue(null);

    const result = await runAttachmentFetch({}, { db: {} as never, job: makeJob() });

    expect(result.files_failed).toBe(1);
    expect(result.attachments_failed).toBe(1);
    expect(mocks.markFailed).toHaveBeenCalledWith('att-1', 'mbox_file_not_found');
  });

  it('marks failed when part not found in mbox', async () => {
    mocks.listNeedsFetch.mockResolvedValue([makeAttachment()]);
    mocks.findById.mockResolvedValue(makeFile());
    mocks.openS3GunzipStream.mockResolvedValue({});
    mocks.streamMboxMessages.mockReturnValue(makeStream([
      { headers: { 'message-id': ['<msg@test.com>'] }, rawBody: '' },
    ]));
    mocks.extractRawAttachmentParts.mockReturnValue([]); // no matching part

    const result = await runAttachmentFetch({}, { db: {} as never, job: makeJob() });

    expect(result.attachments_failed).toBe(1);
    expect(mocks.markFailed).toHaveBeenCalledWith('att-1', 'part_not_found_in_mbox');
  });
});
