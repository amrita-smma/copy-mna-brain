import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
  listDistinctNeedsTriageHashes: vi.fn(),
  setDocType: vi.fn(),
  promoteToUpload: vi.fn(),
  markDropped: vi.fn(),
  markFailed: vi.fn(),
  downloadFile: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mocks.messagesCreate };
  },
}));

vi.mock('../repositories', () => ({
  EmailAttachmentRepository: class {
    listDistinctNeedsTriageHashes = mocks.listDistinctNeedsTriageHashes;
    setDocType = mocks.setDocType;
    promoteToUpload = mocks.promoteToUpload;
    markDropped = mocks.markDropped;
    markFailed = mocks.markFailed;
  },
}));

vi.mock('@/lib/s3', () => ({
  downloadFile: mocks.downloadFile,
}));

import { runAttachmentTriage } from './attachmentTriage';

function makeJob() { return { id: 'job-1' } as never; }

function makeGroup(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    content_hash: 'abc123',
    mime_type: 'application/pdf',
    s3_key: 'attachments/abc123.pdf',
    s3_bucket: 'mbox-archive',
    ids: ['att-1'],
    ...overrides,
  };
}

function makeTriageResponse(doc_type: string, confidence: string) {
  return {
    content: [{
      type: 'tool_use',
      name: 'classify_document',
      input: { doc_type, confidence },
    }],
  };
}

describe('runAttachmentTriage', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    Object.values(mocks).forEach((m) => {
      if (typeof m === 'function' && 'mockReset' in m) (m as ReturnType<typeof vi.fn>).mockReset();
    });
    mocks.setDocType.mockResolvedValue(undefined);
    mocks.promoteToUpload.mockResolvedValue(undefined);
    mocks.markDropped.mockResolvedValue(undefined);
    mocks.markFailed.mockResolvedValue(undefined);
    mocks.downloadFile.mockResolvedValue(Buffer.alloc(100));
  });

  it('returns early with nothing to do', async () => {
    mocks.listDistinctNeedsTriageHashes.mockResolvedValue([]);
    const result = await runAttachmentTriage({}, { db: {} as never, job: makeJob() });
    expect(result).toEqual({ evaluated: 0, classified_deal: 0, classified_other: 0, promoted_direct: 0, dropped_unsupported: 0, failed: 0 });
  });

  it('classifies a deal doc → needs_extract', async () => {
    mocks.listDistinctNeedsTriageHashes.mockResolvedValue([makeGroup()]);
    mocks.messagesCreate.mockResolvedValue(makeTriageResponse('im', 'high'));

    const result = await runAttachmentTriage({}, { db: {} as never, job: makeJob() });

    expect(result.classified_deal).toBe(1);
    expect(mocks.setDocType).toHaveBeenCalledWith(['att-1'], {
      doc_type: 'im', triage_confidence: 'high', nextState: 'needs_extract',
    });
  });

  it('classifies other doc → dropped', async () => {
    mocks.listDistinctNeedsTriageHashes.mockResolvedValue([makeGroup()]);
    mocks.messagesCreate.mockResolvedValue(makeTriageResponse('other', 'high'));

    const result = await runAttachmentTriage({}, { db: {} as never, job: makeJob() });

    expect(result.classified_other).toBe(1);
    expect(mocks.setDocType).toHaveBeenCalledWith(['att-1'], {
      doc_type: 'other', triage_confidence: 'high', nextState: 'dropped',
    });
  });

  it.each([
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ])('promotes supported Office MIME type directly without calling LLM: %s', async (mimeType) => {
    mocks.listDistinctNeedsTriageHashes.mockResolvedValue([makeGroup({ mime_type: mimeType })]);

    const result = await runAttachmentTriage({}, { db: {} as never, job: makeJob() });

    expect(result.promoted_direct).toBe(1);
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
    expect(mocks.promoteToUpload).toHaveBeenCalledWith(['att-1']);
    expect(mocks.markDropped).not.toHaveBeenCalled();
  });

  it('drops unsupported MIME type without calling LLM', async () => {
    mocks.listDistinctNeedsTriageHashes.mockResolvedValue([
      makeGroup({ mime_type: 'application/msword' }),
    ]);

    const result = await runAttachmentTriage({}, { db: {} as never, job: makeJob() });

    expect(result.dropped_unsupported).toBe(1);
    expect(mocks.messagesCreate).not.toHaveBeenCalled();
    expect(mocks.markDropped).toHaveBeenCalledWith(['att-1']);
    expect(mocks.markFailed).toHaveBeenCalledWith('att-1', 'unsupported_type_v1');
  });

  it('marks failed on LLM error', async () => {
    mocks.listDistinctNeedsTriageHashes.mockResolvedValue([makeGroup()]);
    mocks.messagesCreate.mockRejectedValue(new Error('api timeout'));

    const result = await runAttachmentTriage({}, { db: {} as never, job: makeJob() });

    expect(result.failed).toBe(1);
    expect(mocks.markFailed).toHaveBeenCalledWith('att-1', expect.stringContaining('api timeout'));
  });

  it('classifies all deal doc types', async () => {
    const dealTypes = ['prospectus', 'im', 'teaser', 'mom', 'financial_model', 'financial_statement'];
    for (const docType of dealTypes) {
      mocks.listDistinctNeedsTriageHashes.mockResolvedValue([makeGroup({ content_hash: docType })]);
      mocks.messagesCreate.mockResolvedValue(makeTriageResponse(docType, 'high'));
      const result = await runAttachmentTriage({}, { db: {} as never, job: makeJob() });
      expect(result.classified_deal).toBe(1);
    }
  });

  it('fans verdict to multiple rows sharing same content_hash', async () => {
    mocks.listDistinctNeedsTriageHashes.mockResolvedValue([
      makeGroup({ ids: ['att-1', 'att-2', 'att-3'] }),
    ]);
    mocks.messagesCreate.mockResolvedValue(makeTriageResponse('teaser', 'medium'));

    await runAttachmentTriage({}, { db: {} as never, job: makeJob() });

    expect(mocks.setDocType).toHaveBeenCalledWith(
      ['att-1', 'att-2', 'att-3'],
      { doc_type: 'teaser', triage_confidence: 'medium', nextState: 'needs_extract' },
    );
    // Only one LLM call for all three rows
    expect(mocks.messagesCreate).toHaveBeenCalledOnce();
  });
});
