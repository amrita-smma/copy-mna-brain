import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import {
  runVaultParse,
  synthesizeMessageId,
} from './vaultParse';

// --- hoisted mocks --------------------------------------------------------

const mocks = vi.hoisted(() => ({
  // S3Client.send
  s3Send: vi.fn(),
  // MboxFileRepository methods
  findById: vi.fn(),
  listPending: vi.fn(),
  markParsing: vi.fn(),
  markParsed: vi.fn(),
  markFailed: vi.fn(),
  // RawEmailRepository methods
  insertBatch: vi.fn(),
  // mboxParser.streamMboxMessages
  streamMboxMessages: vi.fn(),
}));

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send = mocks.s3Send;
  },
  GetObjectCommand: class {
    constructor(public params: unknown) {}
  },
}));

vi.mock('../mboxParser', async () => {
  const actual = await vi.importActual<typeof import('../mboxParser')>('../mboxParser');
  return {
    ...actual,
    streamMboxMessages: mocks.streamMboxMessages,
  };
});

vi.mock('../repositories', () => ({
  MboxFileRepository: class {
    findById = mocks.findById;
    listPending = mocks.listPending;
    markParsing = mocks.markParsing;
    markParsed = mocks.markParsed;
    markFailed = mocks.markFailed;
  },
  RawEmailRepository: class {
    insertBatch = mocks.insertBatch;
  },
}));

// Mock googleVaultService for extractEmailList, stripAngleBrackets, detectAttachments
vi.mock('@/lib/services/googleVaultService', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/googleVaultService')>(
    '@/lib/services/googleVaultService',
  );
  return actual;
});

// --- helpers --------------------------------------------------------------

function makeFile(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'mb1',
    source: 'vault',
    s3_bucket: 'mbox-archive',
    s3_key: 'vault/2026/04/monthly/x@y.com/exp__x.mbox.gz',
    size_bytes: 1024,
    uncompressed_size_bytes: 4096,
    custodian_email: 'x@y.com',
    window_start: '2026-04-01T00:00:00Z',
    window_end: '2026-05-01T00:00:00Z',
    vault_matter_id: 'm1',
    vault_export_id: 'e1',
    mode: 'monthly',
    job_id: 'job-1',
    parse_status: 'pending',
    parsed_at: null,
    parse_error: null,
    raw_email_count: null,
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    ...overrides,
  };
}

// A minimal RawMessage matching mboxParser's RawMessage interface.
function makeRawMessage(overrides: Partial<{ headers: Record<string, string[]>; rawBody: string }> = {}) {
  return {
    headers: {
      'from': ['Test Sender <a@b.com>'],
      'to': ['x@y.com'],
      'subject': ['Hello'],
      'message-id': ['<abc@mail.x.com>'],
      'date': ['Mon, 01 Apr 2026 00:00:00 +0000'],
      ...overrides.headers,
    },
    rawBody: overrides.rawBody ?? 'This is the email body content for testing purposes.',
  };
}

// A readable stream that yields a valid gzip of empty content
function makeEmptyStream(): Readable {
  // zlib.gzipSync('') produces a valid gzip of empty data that gunzip accepts.
  const { gzipSync } = require('node:zlib') as typeof import('node:zlib');
  return Readable.from([gzipSync(Buffer.alloc(0))]);
}

function setupS3WithStream(stream: Readable = makeEmptyStream()) {
  mocks.s3Send.mockResolvedValue({ Body: stream });
}

// Async generator that yields provided raw messages
async function* makeMessageIterator(
  messages: ReturnType<typeof makeRawMessage>[],
): AsyncGenerator<ReturnType<typeof makeRawMessage>> {
  for (const msg of messages) {
    yield msg;
  }
}

// --- tests ----------------------------------------------------------------

describe('synthesizeMessageId', () => {
  it("produces a stable 'sha256:' prefixed id", () => {
    const email = {
      message_id: null,
      from_email: 'a@b.com',
      from_display_name: null,
      to_emails: ['x@y.com'],
      cc_emails: [],
      subject: 'A',
      body: 'body content',
      sent_at: null,
      has_attachments: false,
      in_reply_to: null,
      references: null,
      gmail_thread_id: null,
      raw_headers: {},
    };
    const a = synthesizeMessageId(email);
    const b = synthesizeMessageId(email);
    expect(a).toBe(b);
    expect(a.startsWith('sha256:')).toBe(true);
  });

  it('changes when content differs', () => {
    const base = {
      message_id: null, from_email: 'a@b.com', from_display_name: null,
      to_emails: [], cc_emails: [], body: 'body', sent_at: null,
      has_attachments: false, in_reply_to: null, references: null,
      gmail_thread_id: null, raw_headers: {},
    };
    const a = synthesizeMessageId({ ...base, subject: 'A' });
    const b = synthesizeMessageId({ ...base, subject: 'B' });
    expect(a).not.toBe(b);
  });
});

describe('runVaultParse', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((m) => {
      if (typeof m === 'function' && 'mockClear' in m) {
        (m as ReturnType<typeof vi.fn>).mockClear();
      }
    });
    mocks.markParsing.mockResolvedValue(makeFile());
    mocks.markParsed.mockResolvedValue(makeFile({ parse_status: 'parsed' }));
    mocks.markFailed.mockResolvedValue(makeFile({ parse_status: 'failed' }));
    mocks.insertBatch.mockResolvedValue([]);
    // Default: S3 returns an empty stream
    setupS3WithStream(makeEmptyStream());
    // Default: streamMboxMessages yields nothing
    mocks.streamMboxMessages.mockReturnValue(makeMessageIterator([]));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('skips a file when markParsing returns null (already claimed)', async () => {
    mocks.listPending.mockResolvedValueOnce([makeFile()]);
    mocks.markParsing.mockResolvedValueOnce(null);

    const result = await runVaultParse(
      {},
      { db: {} as never, job: { id: 'job-1' } as never },
    );

    expect(result.files_skipped).toBe(1);
    expect(result.files_processed).toBe(0);
    expect(mocks.s3Send).not.toHaveBeenCalled();
  });

  it('streams, inserts, and marks parsed for a happy-path file', async () => {
    const raw1 = makeRawMessage({ headers: { 'message-id': ['<a@x>'] } });
    const raw2 = makeRawMessage({ headers: { 'message-id': ['<b@x>'] } });
    mocks.listPending.mockResolvedValueOnce([makeFile()]);
    setupS3WithStream(makeEmptyStream());
    mocks.streamMboxMessages.mockReturnValueOnce(makeMessageIterator([raw1, raw2]));
    mocks.insertBatch.mockResolvedValueOnce([
      { id: 'r1', message_id: 'a@x' },
      { id: 'r2', message_id: 'b@x' },
    ]);

    const result = await runVaultParse(
      {},
      { db: {} as never, job: { id: 'job-1' } as never },
    );

    expect(result.files_processed).toBe(1);
    expect(result.raw_emails_inserted).toBe(2);
    expect(result.raw_emails_skipped_dupe).toBe(0);
    expect(result.raw_emails_synthesized_id).toBe(0);
    expect(mocks.markParsed).toHaveBeenCalledWith('mb1', 2);
  });

  it('counts skipped duplicates when on-conflict absorbs some rows', async () => {
    const raw1 = makeRawMessage({ headers: { 'message-id': ['<a@x>'] } });
    const raw2 = makeRawMessage({ headers: { 'message-id': ['<b@x>'] } });
    const raw3 = makeRawMessage({ headers: { 'message-id': ['<c@x>'] } });
    mocks.listPending.mockResolvedValueOnce([makeFile()]);
    mocks.streamMboxMessages.mockReturnValueOnce(makeMessageIterator([raw1, raw2, raw3]));
    // Only one row returned → two were duplicates
    mocks.insertBatch.mockResolvedValueOnce([{ id: 'r1', message_id: 'a@x' }]);

    const result = await runVaultParse(
      {},
      { db: {} as never, job: { id: 'job-1' } as never },
    );

    expect(result.raw_emails_inserted).toBe(1);
    expect(result.raw_emails_skipped_dupe).toBe(2);
  });

  it('synthesizes an ID for messages with no Message-ID header and increments the counter', async () => {
    const noId = makeRawMessage({ headers: { 'message-id': [] } });
    const withId = makeRawMessage({ headers: { 'message-id': ['<real@x>'] } });
    mocks.listPending.mockResolvedValueOnce([makeFile()]);
    mocks.streamMboxMessages.mockReturnValueOnce(makeMessageIterator([noId, withId]));
    mocks.insertBatch.mockResolvedValueOnce([
      { id: 'r1', message_id: 'sha256:xxx' },
      { id: 'r2', message_id: 'real@x' },
    ]);

    const result = await runVaultParse(
      {},
      { db: {} as never, job: { id: 'job-1' } as never },
    );

    expect(result.raw_emails_synthesized_id).toBe(1);
    const calledRows = mocks.insertBatch.mock.calls[0][0];
    expect(calledRows[0].message_id).toMatch(/^sha256:/);
    expect(calledRows[1].message_id).toBe('real@x');
  });

  it('marks one file failed but continues processing the rest', async () => {
    const f1 = makeFile({ id: 'mb1' });
    const f2 = makeFile({ id: 'mb2' });
    mocks.listPending.mockResolvedValueOnce([f1, f2]);
    mocks.markParsing.mockResolvedValueOnce(f1).mockResolvedValueOnce(f2);
    // First S3 call throws (streamMboxMessages is never called for mb1)
    mocks.s3Send
      .mockRejectedValueOnce(new Error('S3 broke'))
      .mockResolvedValueOnce({ Body: makeEmptyStream() });
    // Second file has one message (first available streamMboxMessages return)
    mocks.streamMboxMessages.mockReturnValueOnce(
      makeMessageIterator([makeRawMessage({ headers: { 'message-id': ['<b@x>'] } })]),
    );
    mocks.insertBatch.mockResolvedValueOnce([{ id: 'r1', message_id: 'b@x' }]);

    const result = await runVaultParse(
      {},
      { db: {} as never, job: { id: 'job-1' } as never },
    );

    expect(result.files_failed).toBe(1);
    expect(result.files_processed).toBe(1);
    expect(mocks.markFailed).toHaveBeenCalledWith('mb1', 'S3 broke');
    expect(mocks.markParsed).toHaveBeenCalledWith('mb2', 1);
  });

  it('with force=true, skips the markParsing claim entirely', async () => {
    const parsedAlready = makeFile({ parse_status: 'parsed' });
    mocks.findById.mockResolvedValueOnce(parsedAlready);
    mocks.streamMboxMessages.mockReturnValueOnce(makeMessageIterator([
      makeRawMessage({ headers: { 'message-id': ['<a@x>'] } }),
    ]));
    mocks.insertBatch.mockResolvedValueOnce([{ id: 'r1', message_id: 'a@x' }]);

    const result = await runVaultParse(
      { fileIds: ['mb1'], force: true },
      { db: {} as never, job: { id: 'job-1' } as never },
    );

    expect(mocks.markParsing).not.toHaveBeenCalled();
    expect(result.files_processed).toBe(1);
  });
});
