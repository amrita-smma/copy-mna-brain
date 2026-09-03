import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadSecretsFromSsm: vi.fn().mockResolvedValue(undefined),
  createLambdaDb: vi.fn(),
  pgClientEnd: vi.fn().mockResolvedValue(undefined),
  listPendingClassification: vi.fn().mockResolvedValue([]),
  countSelectedToday: vi.fn().mockResolvedValue({}),
  applyClassifications: vi.fn().mockResolvedValue(undefined),
  listPendingContent: vi.fn().mockResolvedValue([]),
  recordContentSuccess: vi.fn().mockResolvedValue(undefined),
  recordContentFailure: vi.fn().mockResolvedValue(undefined),
  listPendingEmbedding: vi.fn().mockResolvedValue([]),
  saveChunks: vi.fn().mockResolvedValue(undefined),
  startRun: vi.fn().mockResolvedValue('run-1'),
  finishRun: vi.fn().mockResolvedValue(undefined),
  classifyBatch: vi.fn().mockResolvedValue([]),
  fetchArticleContent: vi.fn(),
  embed: vi.fn(),
}));

vi.mock('../secrets', () => ({ loadSecretsFromSsm: mocks.loadSecretsFromSsm }));
vi.mock('../db', () => ({ createLambdaDb: mocks.createLambdaDb }));
vi.mock('../repositories', () => ({
  RssRepository: class {
    listPendingClassification = mocks.listPendingClassification;
    countSelectedToday = mocks.countSelectedToday;
    applyClassifications = mocks.applyClassifications;
    listPendingContent = mocks.listPendingContent;
    recordContentSuccess = mocks.recordContentSuccess;
    recordContentFailure = mocks.recordContentFailure;
    listPendingEmbedding = mocks.listPendingEmbedding;
    saveChunks = mocks.saveChunks;
    startRun = mocks.startRun;
    finishRun = mocks.finishRun;
  },
}));
vi.mock('../handlers/rssClassify', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../handlers/rssClassify')>();
  return { ...actual, classifyBatch: mocks.classifyBatch };
});
vi.mock('../lib/rssContent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/rssContent')>();
  return { ...actual, fetchArticleContent: mocks.fetchArticleContent };
});
vi.mock('@/lib/bedrock', () => ({
  EMBEDDING_DIMENSIONS: 1024,
  BedrockEmbeddingClient: class {
    embed = mocks.embed;
  },
}));

import { handler } from './rssEnrich';

function pending(id: string, category = 'new_funding') {
  return {
    id,
    category,
    source_name: 'Wire',
    feed_tier: 'curated' as const,
    title: `Title ${id}`,
    summary: 'Summary',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createLambdaDb.mockResolvedValue({ pgClient: { end: mocks.pgClientEnd }, db: {} });
  mocks.startRun.mockResolvedValue('run-1');
  mocks.listPendingClassification.mockResolvedValue([]);
  mocks.listPendingContent.mockResolvedValue([]);
  mocks.listPendingEmbedding.mockResolvedValue([]);
  mocks.countSelectedToday.mockResolvedValue({});
  mocks.embed.mockResolvedValue(Array.from({ length: 1024 }, () => 0.01));
});

describe('rss-enrich — classification stage', () => {
  it('classifies pending items and persists the decisions', async () => {
    mocks.listPendingClassification.mockResolvedValue([pending('i1')]);
    mocks.classifyBatch.mockResolvedValue([
      { index: 0, relevant: true, score: 0.9, companies: [], topics: [], reason: 'r' },
    ]);

    const out = await handler({}, {});

    expect(out.result.classified).toBe(1);
    expect(out.result.selected).toBe(1);
    expect(mocks.applyClassifications).toHaveBeenCalledTimes(1);
  });

  it('respects the remaining daily cap for a category', async () => {
    process.env.RSS_DAILY_CAP_PER_CATEGORY = '2';
    mocks.listPendingClassification.mockResolvedValue([pending('i1'), pending('i2')]);
    // One already selected today, so only one slot remains.
    mocks.countSelectedToday.mockResolvedValue({ new_funding: 1 });
    mocks.classifyBatch.mockResolvedValue([
      { index: 0, relevant: true, score: 0.95, companies: [], topics: [], reason: 'r' },
      { index: 1, relevant: true, score: 0.9, companies: [], topics: [], reason: 'r' },
    ]);

    const out = await handler({}, {});

    expect(out.result.selected).toBe(1);
    delete process.env.RSS_DAILY_CAP_PER_CATEGORY;
  });

  it('skips the whole stage when nothing is pending', async () => {
    await handler({}, {});
    expect(mocks.classifyBatch).not.toHaveBeenCalled();
    expect(mocks.applyClassifications).not.toHaveBeenCalled();
  });

  it('leaves items pending (does not reject them) when the model call fails for the whole batch', async () => {
    // classifyBatch returns [] on a real outage (see its own catch block), and
    // decideSelections turns an empty verdict list into "reject everything,
    // reason 'no verdict'". If the `verdicts.length === 0` guard in
    // runClassification were ever removed, this batch would be rejected
    // outright instead of skipped — permanently discarding a whole day of
    // news with no retry. This test fails without that guard: applyClassifications
    // would be called with 2 rejected decisions and result.classified would be 2.
    mocks.listPendingClassification.mockResolvedValue([pending('i1'), pending('i2')]);
    mocks.classifyBatch.mockResolvedValue([]);

    const out = await handler({}, {});

    expect(mocks.applyClassifications).not.toHaveBeenCalled();
    expect(out.result.classified).toBe(0);
    expect(out.result.selected).toBe(0);
  });

  it('never selects more than the daily cap across multiple batches within one run', async () => {
    // CLASSIFY_BATCH_SIZE is 20, so 25 pending items in one category forces
    // two batches. decideSelections enforces the cap only *within* the batch
    // it's given — it shallow-copies remainingByCategory internally and does
    // not mutate the caller's object. runClassification must therefore
    // decrement `remaining[item.category]` itself after each batch so the
    // second batch sees the budget the first batch already spent. If that
    // decrement were removed, each batch would independently think the full
    // cap (10) was available: batch 1 (20 items) would select 10, batch 2 (5
    // items) would also select all 5 against a fresh 10-budget, for 15
    // total — this test would then fail (15 > 10 / !== 10).
    process.env.RSS_DAILY_CAP_PER_CATEGORY = '10';
    const items = Array.from({ length: 25 }, (_, i) => pending(`i${i}`));
    mocks.listPendingClassification.mockResolvedValue(items);
    mocks.countSelectedToday.mockResolvedValue({});
    // One verdicts array reused for both batches: batch 1 has 20 items (uses
    // indices 0-19), batch 2 has 5 items (uses indices 0-4 of this same
    // array) — every item scores high enough to clear the curated threshold.
    mocks.classifyBatch.mockResolvedValue(
      Array.from({ length: 20 }, (_, index) => ({
        index,
        relevant: true,
        score: 0.99,
        companies: [],
        topics: [],
        reason: 'r',
      })),
    );

    const out = await handler({}, {});

    expect(out.result.selected).toBeLessThanOrEqual(10);
    expect(out.result.selected).toBe(10);
    delete process.env.RSS_DAILY_CAP_PER_CATEGORY;
  });
});

describe('rss-enrich — content stage', () => {
  it('stores fetched article text', async () => {
    mocks.listPendingContent.mockResolvedValue([
      { id: 'i1', link: 'https://example.com/a', title: 'T', summary: 'S' },
    ]);
    mocks.fetchArticleContent.mockResolvedValue({ kind: 'ok', text: 'Full body text' });

    const out = await handler({}, {});

    expect(out.result.content_fetched).toBe(1);
    expect(mocks.recordContentSuccess).toHaveBeenCalledWith('i1', 'Full body text');
  });

  it('burns an attempt on failure without aborting the other items', async () => {
    mocks.listPendingContent.mockResolvedValue([
      { id: 'i1', link: 'https://example.com/a', title: 'T', summary: 'S' },
      { id: 'i2', link: 'https://example.com/b', title: 'T', summary: 'S' },
    ]);
    mocks.fetchArticleContent
      .mockResolvedValueOnce({ kind: 'failed', reason: 'http 403' })
      .mockResolvedValueOnce({ kind: 'ok', text: 'Body' });

    const out = await handler({}, {});

    expect(out.result.content_failed).toBe(1);
    expect(out.result.content_fetched).toBe(1);
    expect(mocks.recordContentFailure).toHaveBeenCalledWith('i1', 'http 403');
  });
});

describe('rss-enrich — embedding stage', () => {
  it('embeds each chunk of a fetched article and saves them', async () => {
    mocks.listPendingEmbedding.mockResolvedValue([
      { id: 'i1', title: 'T', content_text: 'Body text here.', summary: 'S', content_status: 'fetched' },
    ]);

    const out = await handler({}, {});

    expect(out.result.items_embedded).toBe(1);
    expect(out.result.chunks_written).toBeGreaterThan(0);
    expect(mocks.saveChunks).toHaveBeenCalledTimes(1);
  });

  it('falls back to title+summary for an item whose content fetch terminally failed', async () => {
    mocks.listPendingEmbedding.mockResolvedValue([
      { id: 'i1', title: 'Acme raises', content_text: null, summary: 'A funding round.', content_status: 'failed' },
    ]);

    await handler({}, {});

    const chunks = mocks.saveChunks.mock.calls[0][1] as { text: string }[];
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('A funding round.');
  });

  it('leaves an item unembedded when Bedrock fails, so a later run retries it', async () => {
    mocks.listPendingEmbedding.mockResolvedValue([
      { id: 'i1', title: 'T', content_text: 'Body', summary: 'S', content_status: 'fetched' },
    ]);
    mocks.embed.mockRejectedValue(new Error('throttled'));

    const out = await handler({}, {});

    expect(out.ok).toBe(true);
    expect(out.result.items_embedded).toBe(0);
    expect(mocks.saveChunks).not.toHaveBeenCalled();
  });
});

describe('rss-enrich — run bookkeeping', () => {
  it('records the run and closes the pg client', async () => {
    await handler({}, {});
    expect(mocks.startRun).toHaveBeenCalledWith('enrich');
    expect(mocks.finishRun).toHaveBeenCalledWith('run-1', expect.any(Object), null);
    expect(mocks.pgClientEnd).toHaveBeenCalledTimes(1);
  });

  it('records the error and rethrows when a stage blows up', async () => {
    mocks.listPendingClassification.mockRejectedValue(new Error('db down'));

    await expect(handler({}, {})).rejects.toThrow('db down');

    expect(mocks.finishRun).toHaveBeenCalledWith('run-1', expect.any(Object), 'db down');
    expect(mocks.pgClientEnd).toHaveBeenCalledTimes(1);
  });
});
