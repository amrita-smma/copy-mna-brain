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
  listPendingTranslation: vi.fn().mockResolvedValue([]),
  recordTranslationSuccess: vi.fn().mockResolvedValue(undefined),
  markTranslationNotNeeded: vi.fn().mockResolvedValue(undefined),
  recordTranslationFailure: vi.fn().mockResolvedValue(undefined),
  listPendingEmbedding: vi.fn().mockResolvedValue([]),
  saveChunks: vi.fn().mockResolvedValue(undefined),
  startRun: vi.fn().mockResolvedValue('run-1'),
  finishRun: vi.fn().mockResolvedValue(undefined),
  classifyBatch: vi.fn().mockResolvedValue([]),
  fetchArticleContent: vi.fn(),
  translateItem: vi.fn(),
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
    listPendingTranslation = mocks.listPendingTranslation;
    recordTranslationSuccess = mocks.recordTranslationSuccess;
    markTranslationNotNeeded = mocks.markTranslationNotNeeded;
    recordTranslationFailure = mocks.recordTranslationFailure;
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
vi.mock('../handlers/rssTranslate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../handlers/rssTranslate')>();
  return { ...actual, translateItem: mocks.translateItem };
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
  mocks.listPendingTranslation.mockResolvedValue([]);
  mocks.listPendingEmbedding.mockResolvedValue([]);
  mocks.translateItem.mockResolvedValue({ kind: 'not_needed', language: 'en' });
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

describe('rss-enrich — translation stage', () => {
  /**
   * Japanese, and long enough for the real `detectItemLanguage` to call it —
   * the stage's own gate is NOT mocked, so a fixture that reads as English
   * would be filtered out before `translateItem` is ever consulted.
   */
  function foreign(id = 'i1') {
    return {
      id,
      title: 'ソフトバンクグループ、アーム株式の追加取得を発表',
      summary: '同社は半導体設計会社アームの株式を追加で取得したと発表した。取得額は明らかにしていない。',
      content_text: '本文が続きます。',
    };
  }

  /** English, so the local gate settles it without a model call. */
  function english(id = 'i1') {
    return {
      id,
      title: 'Aldergate Industrial acquires Penvale Controls for $310m',
      summary:
        'The acquisition adds process-control instrumentation to the automation portfolio and closes a product gap that management has flagged to investors for several reporting periods.',
      content_text: null,
    };
  }

  it('stores the English rendering alongside the original', async () => {
    mocks.listPendingTranslation.mockResolvedValue([foreign()]);
    mocks.translateItem.mockResolvedValue({
      kind: 'translated',
      language: 'ja',
      title: 'Title',
      summary: 'Summary',
      content: 'Body',
    });

    const out = await handler({}, {});

    expect(out.result.translated).toBe(1);
    expect(mocks.recordTranslationSuccess).toHaveBeenCalledWith('i1', {
      language: 'ja',
      title: 'Title',
      summary: 'Summary',
      content: 'Body',
    });
  });

  it('settles English items locally, without spending a model call', async () => {
    // The whole point of the local gate: the catalog is majority-English, so
    // paying Haiku to be told "already English" would dominate the stage.
    mocks.listPendingTranslation.mockResolvedValue([english('i1'), english('i2')]);

    const out = await handler({}, {});

    expect(out.result.translation_skipped).toBe(2);
    expect(out.result.translated).toBe(0);
    expect(mocks.translateItem).not.toHaveBeenCalled();
    expect(mocks.markTranslationNotNeeded).toHaveBeenCalledWith([
      { id: 'i1', language: 'en' },
      { id: 'i2', language: 'en' },
    ]);
  });

  it('settles the English majority in ONE write, not one per row', async () => {
    // A loop of UPDATEs here would be a write-side N+1 on the stage's hottest
    // path — DETECT_LIMIT is 200 and nearly all of it is English.
    mocks.listPendingTranslation.mockResolvedValue(
      Array.from({ length: 60 }, (_, i) => english(`i${i}`)),
    );

    await handler({}, {});

    expect(mocks.markTranslationNotNeeded).toHaveBeenCalledTimes(1);
    expect(mocks.markTranslationNotNeeded.mock.calls[0][0]).toHaveLength(60);
  });

  it('records a null language when the text is too short to judge', async () => {
    // The detector reports null below its word floor. Recording a guessed
    // 'en' would state as fact something never established.
    mocks.listPendingTranslation.mockResolvedValue([
      { id: 'i1', title: 'Acme buys Penvale', summary: null, content_text: null },
    ]);

    await handler({}, {});

    expect(mocks.markTranslationNotNeeded).toHaveBeenCalledWith([
      { id: 'i1', language: null },
    ]);
  });

  it('caps model calls at TRANSLATE_LIMIT and reports the deferred remainder', async () => {
    // DETECT_LIMIT (200) is far above TRANSLATE_LIMIT (15) because detection
    // is free and translation is not. The overflow must be counted, not
    // silently dropped — the next run picks it up.
    mocks.listPendingTranslation.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => foreign(`i${i}`)),
    );
    mocks.translateItem.mockResolvedValue({
      kind: 'translated',
      language: 'ja',
      title: 'T',
      summary: null,
      content: null,
    });

    const out = await handler({}, {});

    expect(mocks.translateItem).toHaveBeenCalledTimes(15);
    expect(out.result.translated).toBe(15);
    expect(out.result.translation_deferred).toBe(5);
  });

  it('does not let an English backlog consume the translation budget', async () => {
    // This is the failure mode the two limits exist to prevent: if English
    // rows counted against TRANSLATE_LIMIT, a backlog of them would starve
    // the embed queue, which waits on translation resolving.
    mocks.listPendingTranslation.mockResolvedValue([
      ...Array.from({ length: 50 }, (_, i) => english(`e${i}`)),
      foreign('j1'),
    ]);
    mocks.translateItem.mockResolvedValue({
      kind: 'translated',
      language: 'ja',
      title: 'T',
      summary: null,
      content: null,
    });

    const out = await handler({}, {});

    expect(out.result.translated).toBe(1);
    expect(out.result.translation_deferred).toBe(0);
    expect(mocks.translateItem).toHaveBeenCalledTimes(1);
  });

  it('burns an attempt on a failed outcome', async () => {
    mocks.listPendingTranslation.mockResolvedValue([foreign()]);
    mocks.translateItem.mockResolvedValue({ kind: 'failed', reason: 'overloaded' });

    const out = await handler({}, {});

    expect(out.result.translation_failed).toBe(1);
    expect(mocks.recordTranslationFailure).toHaveBeenCalledWith('i1', 'overloaded');
  });

  it('keeps draining the queue when one item throws outright', async () => {
    // Per-item isolation, as in every other stage: a thrown error (a DB write
    // blowing up, say) must not abort the invocation before embedding runs.
    mocks.listPendingTranslation.mockResolvedValue([foreign('i1'), foreign('i2')]);
    mocks.translateItem.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({
      kind: 'translated',
      language: 'ja',
      title: 'T',
      summary: null,
      content: null,
    });

    const out = await handler({}, {});

    expect(out.ok).toBe(true);
    expect(out.result.translation_failed).toBe(1);
    expect(out.result.translated).toBe(1);
    expect(mocks.recordTranslationFailure).toHaveBeenCalledWith('i1', 'boom');
  });

  it('skips the stage entirely when the queue is empty', async () => {
    await handler({}, {});
    expect(mocks.translateItem).not.toHaveBeenCalled();
    expect(mocks.markTranslationNotNeeded).not.toHaveBeenCalled();
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

  it('embeds the English translation, not the original, when one exists', async () => {
    // Both halves of hybrid search are English — an English query embedding
    // and a trigram ILIKE over English words — so indexing the Japanese body
    // would leave the item unreachable by any query a user would type.
    mocks.listPendingEmbedding.mockResolvedValue([
      {
        id: 'i1',
        title: 'ソフトバンク、Arm株を追加取得',
        content_text: '本文が続きます。',
        summary: '要約',
        content_status: 'fetched',
        title_en: 'SoftBank buys additional Arm shares',
        summary_en: 'Summary',
        content_text_en: 'The body continues.',
      },
    ]);

    await handler({}, {});

    const chunks = mocks.saveChunks.mock.calls[0][1] as { text: string }[];
    expect(chunks[0].text).toContain('SoftBank buys additional Arm shares');
    expect(chunks[0].text).toContain('The body continues.');
    expect(chunks[0].text).not.toContain('本文が続きます。');
  });

  it('falls back to the original text when translation terminally failed', async () => {
    // A `failed` translation is still embeddable — burying the item entirely
    // would be worse than indexing it in its own language.
    mocks.listPendingEmbedding.mockResolvedValue([
      {
        id: 'i1',
        title: 'Titel auf Deutsch',
        content_text: 'Der Text.',
        summary: 'Zusammenfassung',
        content_status: 'fetched',
        title_en: null,
        summary_en: null,
        content_text_en: null,
      },
    ]);

    await handler({}, {});

    const chunks = mocks.saveChunks.mock.calls[0][1] as { text: string }[];
    expect(chunks[0].text).toContain('Titel auf Deutsch');
    expect(chunks[0].text).toContain('Der Text.');
  });

  it('uses the translated summary when the content fetch failed', async () => {
    mocks.listPendingEmbedding.mockResolvedValue([
      {
        id: 'i1',
        title: '見出し',
        content_text: null,
        summary: '要約テキスト',
        content_status: 'failed',
        title_en: 'Headline',
        summary_en: 'Summary text.',
        content_text_en: null,
      },
    ]);

    await handler({}, {});

    const chunks = mocks.saveChunks.mock.calls[0][1] as { text: string }[];
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('Headline');
    expect(chunks[0].text).toContain('Summary text.');
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
