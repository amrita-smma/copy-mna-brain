import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
  listDistinctNeedsExtractHashes: vi.fn(),
  markExtracted: vi.fn(),
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
    listDistinctNeedsExtractHashes = mocks.listDistinctNeedsExtractHashes;
    markExtracted = mocks.markExtracted;
    markFailed = mocks.markFailed;
  },
}));

vi.mock('@/lib/s3', () => ({
  downloadFile: mocks.downloadFile,
}));

import { runAttachmentExtract } from './attachmentExtract';

function makeJob() { return { id: 'job-1' } as never; }

function makeGroup(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    content_hash: 'abc123def456',
    doc_type: 'im',
    s3_key: 'attachments/abc123def456.pdf',
    s3_bucket: 'mbox-archive',
    ids: ['att-1'],
    ...overrides,
  };
}

function makeExtractResponse(fields: Record<string, unknown> = {}) {
  return {
    content: [{
      type: 'tool_use',
      name: 'extract_deal_info',
      input: {
        company_name: 'Acme Corp',
        revenue_usd_mn: 120.5,
        ebitda_usd_mn: 24.0,
        net_income_usd_mn: null,
        valuation_usd_mn: 480.0,
        deal_size_usd_mn: null,
        currency: 'USD',
        fiscal_period: 'FY2024',
        deal_stage: null,
        industry: 'Technology',
        key_dates: null,
        counterparties: ['Goldman Sachs'],
        summary: 'Acquisition of Acme Corp by a strategic buyer.',
        ...fields,
      },
    }],
  };
}

describe('runAttachmentExtract', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    Object.values(mocks).forEach((m) => {
      if (typeof m === 'function' && 'mockReset' in m) (m as ReturnType<typeof vi.fn>).mockReset();
    });
    mocks.markExtracted.mockResolvedValue(undefined);
    mocks.markFailed.mockResolvedValue(undefined);
    mocks.downloadFile.mockResolvedValue(Buffer.alloc(1000));
  });

  it('returns early with nothing to do', async () => {
    mocks.listDistinctNeedsExtractHashes.mockResolvedValue([]);
    const result = await runAttachmentExtract({}, { db: {} as never, job: makeJob() });
    expect(result).toEqual({ evaluated: 0, extracted: 0, failed: 0 });
  });

  it('extracts and marks done with structured output', async () => {
    mocks.listDistinctNeedsExtractHashes.mockResolvedValue([makeGroup()]);
    mocks.messagesCreate.mockResolvedValue(makeExtractResponse());

    const result = await runAttachmentExtract({}, { db: {} as never, job: makeJob() });

    expect(result.extracted).toBe(1);
    expect(mocks.markExtracted).toHaveBeenCalledWith(
      ['att-1'],
      expect.objectContaining({ company_name: 'Acme Corp', revenue_usd_mn: 120.5 }),
    );
  });

  it('accepts sparse output with mostly null fields (teaser/MoM scenario)', async () => {
    mocks.listDistinctNeedsExtractHashes.mockResolvedValue([
      makeGroup({ doc_type: 'teaser' }),
    ]);
    mocks.messagesCreate.mockResolvedValue(makeExtractResponse({
      company_name: 'Startup X',
      revenue_usd_mn: null,
      ebitda_usd_mn: null,
      valuation_usd_mn: null,
      summary: 'Early stage fintech seeking Series B.',
    }));

    const result = await runAttachmentExtract({}, { db: {} as never, job: makeJob() });

    expect(result.extracted).toBe(1);
    const [, extracted] = mocks.markExtracted.mock.calls[0] as [string[], Record<string, unknown>];
    expect(extracted.revenue_usd_mn).toBeNull();
    expect(extracted.ebitda_usd_mn).toBeNull();
    expect(extracted.company_name).toBe('Startup X');
  });

  it('marks all rows failed on LLM error', async () => {
    mocks.listDistinctNeedsExtractHashes.mockResolvedValue([makeGroup()]);
    mocks.messagesCreate.mockRejectedValue(new Error('rate limit'));

    const result = await runAttachmentExtract({}, { db: {} as never, job: makeJob() });

    expect(result.failed).toBe(1);
    expect(mocks.markFailed).toHaveBeenCalledWith('att-1', expect.stringContaining('rate limit'));
  });

  it('fans extraction to all rows sharing the same content_hash', async () => {
    mocks.listDistinctNeedsExtractHashes.mockResolvedValue([
      makeGroup({ ids: ['att-1', 'att-2', 'att-3'] }),
    ]);
    mocks.messagesCreate.mockResolvedValue(makeExtractResponse());

    await runAttachmentExtract({}, { db: {} as never, job: makeJob() });

    expect(mocks.markExtracted).toHaveBeenCalledWith(
      ['att-1', 'att-2', 'att-3'],
      expect.any(Object),
    );
    expect(mocks.messagesCreate).toHaveBeenCalledOnce();
  });

  it('continues processing remaining docs after one failure', async () => {
    const group1 = makeGroup({ content_hash: 'hash1', ids: ['att-1'] });
    const group2 = makeGroup({ content_hash: 'hash2', ids: ['att-2'] });
    mocks.listDistinctNeedsExtractHashes.mockResolvedValue([group1, group2]);
    mocks.messagesCreate
      .mockRejectedValueOnce(new Error('PDF too large'))
      .mockResolvedValueOnce(makeExtractResponse());

    const result = await runAttachmentExtract({}, { db: {} as never, job: makeJob() });

    expect(result.failed).toBe(1);
    expect(result.extracted).toBe(1);
  });
});
