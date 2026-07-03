import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { runCrmLlmFetch } from './crmLlmFetch';

const mocks = vi.hoisted(() => ({
  batchesRetrieve: vi.fn(),
  batchesResults: vi.fn(),
  listInProgress: vi.fn(),
  markEnded: vi.fn(),
  markFetched: vi.fn(),
  markFailed: vi.fn(),
  setLlmResult: vi.fn(),
  findByRawEmailIds: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = {
      batches: {
        retrieve: mocks.batchesRetrieve,
        results: mocks.batchesResults,
      },
    };
  },
}));

vi.mock('@/lib/repositories', () => ({}));

vi.mock('../repositories', () => ({
  LlmBatchRepository: class {
    listInProgress = mocks.listInProgress;
    markEnded = mocks.markEnded;
    markFetched = mocks.markFetched;
    markFailed = mocks.markFailed;
  },
  RawEmailEnrichmentRepository: class {
    setLlmResult = mocks.setLlmResult;
    findByRawEmailIds = mocks.findByRawEmailIds;
  },
}));

function makeDb() {
  return {
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue([]),
  };
}

async function* makeResultsStream<T>(items: T[]) {
  for (const item of items) yield item;
}

describe('runCrmLlmFetch', () => {
  const originalEnv = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    Object.values(mocks).forEach((m) => {
      if (typeof m === 'function' && 'mockClear' in m) (m as ReturnType<typeof vi.fn>).mockClear();
    });
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    mocks.findByRawEmailIds.mockResolvedValue([]);
    mocks.setLlmResult.mockResolvedValue({});
    mocks.markEnded.mockResolvedValue({});
    mocks.markFetched.mockResolvedValue({});
    mocks.markFailed.mockResolvedValue({});
  });

  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = originalEnv;
    vi.clearAllMocks();
  });

  it('no-ops cleanly when there are no in-flight batches', async () => {
    mocks.listInProgress.mockResolvedValueOnce([]);
    const result = await runCrmLlmFetch(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );
    expect(result.batches_polled).toBe(0);
    expect(mocks.batchesRetrieve).not.toHaveBeenCalled();
  });

  it("does nothing for a batch still in 'in_progress'", async () => {
    mocks.listInProgress.mockResolvedValueOnce([
      {
        id: 'b1',
        anthropic_batch_id: 'msgbatch_x',
        status: 'in_progress',
        custom_id_map: { c1: 'r1' },
      },
    ]);
    mocks.batchesRetrieve.mockResolvedValueOnce({ processing_status: 'in_progress' });

    const result = await runCrmLlmFetch(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );

    expect(result.batches_polled).toBe(1);
    expect(result.batches_fetched).toBe(0);
    expect(mocks.markEnded).not.toHaveBeenCalled();
  });

  it("marks ended, fetches results, and writes enrichment for 'ended'", async () => {
    mocks.listInProgress.mockResolvedValueOnce([
      {
        id: 'b1',
        anthropic_batch_id: 'msgbatch_x',
        status: 'in_progress',
        model: 'claude-haiku-4-5',
        custom_id_map: { c1: 'r1' },
      },
    ]);
    mocks.batchesRetrieve.mockResolvedValueOnce({ processing_status: 'ended' });
    mocks.findByRawEmailIds.mockResolvedValueOnce([
      { raw_email_id: 'r1', candidates: [] },
    ]);
    mocks.batchesResults.mockResolvedValueOnce(
      makeResultsStream([
        {
          custom_id: 'c1',
          result: {
            type: 'succeeded',
            message: {
              content: [
                {
                  type: 'tool_use',
                  input: { topics: ['nda'], people: [] },
                },
              ],
            },
          },
        },
      ]),
    );

    const result = await runCrmLlmFetch(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );

    expect(result.batches_fetched).toBe(1);
    expect(result.rows_enriched).toBe(1);
    expect(mocks.markEnded).toHaveBeenCalled();
    expect(mocks.markFetched).toHaveBeenCalledWith('b1', 'j1');
    expect(mocks.setLlmResult).toHaveBeenCalled();
  });

  it('drops personal/1-1 emails as filtered without writing evidence', async () => {
    mocks.listInProgress.mockResolvedValueOnce([
      {
        id: 'b1',
        anthropic_batch_id: 'msgbatch_x',
        status: 'in_progress',
        model: 'claude-haiku-4-5',
        custom_id_map: { c1: 'r1' },
      },
    ]);
    mocks.batchesRetrieve.mockResolvedValueOnce({ processing_status: 'ended' });
    mocks.findByRawEmailIds.mockResolvedValueOnce([{ raw_email_id: 'r1', candidates: [] }]);
    mocks.batchesResults.mockResolvedValueOnce(
      makeResultsStream([
        {
          custom_id: 'c1',
          result: {
            type: 'succeeded',
            message: {
              content: [
                {
                  type: 'tool_use',
                  input: { is_personal: true, topics: [], people: [], related_companies: [] },
                },
              ],
            },
          },
        },
      ]),
    );

    const result = await runCrmLlmFetch(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );

    expect(result.rows_filtered).toBe(1);
    expect(result.rows_enriched).toBe(0);
    expect(mocks.setLlmResult).not.toHaveBeenCalled();
  });

  it("marks batches as failed when processing_status is neither 'in_progress' nor 'ended'", async () => {
    mocks.listInProgress.mockResolvedValueOnce([
      {
        id: 'b1',
        anthropic_batch_id: 'msgbatch_x',
        status: 'in_progress',
        custom_id_map: { c1: 'r1' },
      },
    ]);
    mocks.batchesRetrieve.mockResolvedValueOnce({ processing_status: 'canceling' });

    const result = await runCrmLlmFetch(
      {},
      { db: makeDb() as never, job: { id: 'j1' } as never },
    );

    expect(result.batches_failed).toBe(1);
    expect(mocks.markFailed).toHaveBeenCalled();
  });
});
