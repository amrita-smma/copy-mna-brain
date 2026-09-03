import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RssRepository, MAX_CONSECUTIVE_FAILURES } from './rssRepository';
import type { NormalizedItem } from '../handlers/rssNormalize';

// Flatten a drizzle `sql` template back to its text so we can assert on the
// statement without a live database.
function sqlText(q: unknown): string {
  const chunks = (q as { queryChunks?: unknown[] } | null)?.queryChunks ?? [];
  return chunks
    .map((c) => {
      if (typeof c === 'string' || typeof c === 'number') return String(c);
      if (c && typeof c === 'object' && 'value' in (c as object)) {
        const v = (c as { value: unknown }).value;
        return Array.isArray(v) ? v.join('') : String(v);
      }
      return '';
    })
    .join('');
}

const selectChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn(),
};
const insertChain = {
  values: vi.fn().mockReturnThis(),
  onConflictDoNothing: vi.fn().mockReturnThis(),
  returning: vi.fn(),
};
const updateChain = {
  set: vi.fn().mockReturnThis(),
  where: vi.fn(),
};

const mockDb = {
  select: vi.fn().mockReturnValue(selectChain),
  insert: vi.fn().mockReturnValue(insertChain),
  update: vi.fn().mockReturnValue(updateChain),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
};

function resetDb() {
  vi.clearAllMocks();
  mockDb.select.mockReturnValue(selectChain);
  mockDb.insert.mockReturnValue(insertChain);
  mockDb.update.mockReturnValue(updateChain);
  mockDb.execute.mockResolvedValue({ rows: [] });
  selectChain.from.mockReturnThis();
  selectChain.where.mockReturnThis();
  insertChain.values.mockReturnThis();
  insertChain.onConflictDoNothing.mockReturnThis();
  updateChain.set.mockReturnThis();
}

function item(hash: string): NormalizedItem {
  return {
    item_hash: hash,
    feed_id: 'feed-1',
    category: 'new_funding',
    source_name: 'Wire',
    region: 'US',
    feed_tier: 'curated',
    title: 'T',
    link: `https://example.com/${hash}`,
    summary: null,
    authors: null,
    tags: null,
    published_at: null,
  };
}

describe('RssRepository.listActiveFeeds', () => {
  beforeEach(resetDb);

  it('selects only active feeds', async () => {
    selectChain.orderBy.mockResolvedValueOnce([{ id: 'feed-1' }]);
    const repo = new RssRepository(mockDb as never);

    const feeds = await repo.listActiveFeeds();

    expect(feeds).toEqual([{ id: 'feed-1' }]);
    expect(selectChain.where).toHaveBeenCalledTimes(1);
  });
});

describe('RssRepository.insertNewItems', () => {
  beforeEach(resetDb);

  it('returns [] without touching the DB for an empty batch', async () => {
    const repo = new RssRepository(mockDb as never);
    expect(await repo.insertNewItems([])).toEqual([]);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('ignores conflicts on item_hash and returns only the genuinely new rows', async () => {
    // Two submitted, one already seen: the DB returns a single hash.
    insertChain.returning.mockResolvedValueOnce([{ item_hash: 'a' }]);
    const repo = new RssRepository(mockDb as never);

    const created = await repo.insertNewItems([item('a'), item('b')]);

    expect(insertChain.onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(created.map((i) => i.item_hash)).toEqual(['a']);
  });

  it('chunks very large batches so the driver parameter limit is never hit', async () => {
    insertChain.returning.mockResolvedValue([]);
    const repo = new RssRepository(mockDb as never);

    await repo.insertNewItems(Array.from({ length: 1200 }, (_, i) => item(`h${i}`)));

    // 1200 rows / 500 per chunk = 3 inserts.
    expect(mockDb.insert).toHaveBeenCalledTimes(3);
  });
});

describe('RssRepository.applyFeedHealth', () => {
  beforeEach(resetDb);

  it('does nothing for an empty update list', async () => {
    const repo = new RssRepository(mockDb as never);
    await repo.applyFeedHealth([]);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('updates every feed in one statement, not one per feed', async () => {
    const repo = new RssRepository(mockDb as never);

    await repo.applyFeedHealth([
      { id: 'f1', ok: true, etag: 'W/"1"', lastModified: null },
      { id: 'f2', ok: false },
    ]);

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain('UPDATE rss.feeds');
    expect(text).toContain('jsonb_to_recordset');
  });

  it('retires a feed once it crosses the consecutive-failure budget', async () => {
    const repo = new RssRepository(mockDb as never);

    await repo.applyFeedHealth([{ id: 'f1', ok: false }]);

    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain(`>= ${MAX_CONSECUTIVE_FAILURES}`);
    expect(text).toContain("'dead'");
  });

  it('keeps the previous etag when the poll produced none (304 or failure)', async () => {
    const repo = new RssRepository(mockDb as never);

    await repo.applyFeedHealth([{ id: 'f1', ok: true }]);

    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain('COALESCE(u.etag, f.etag)');
  });
});

describe('RssRepository run bookkeeping', () => {
  beforeEach(resetDb);

  it('startRun inserts a row and returns its id', async () => {
    insertChain.returning.mockResolvedValueOnce([{ id: 'run-1' }]);
    const repo = new RssRepository(mockDb as never);

    expect(await repo.startRun('poll')).toBe('run-1');
    expect(insertChain.values).toHaveBeenCalledWith({ kind: 'poll' });
  });

  it('finishRun stamps finished_at with the stats payload', async () => {
    updateChain.where.mockResolvedValueOnce(undefined);
    const repo = new RssRepository(mockDb as never);

    await repo.finishRun('run-1', { feeds: 3 });

    const setArg = updateChain.set.mock.calls[0][0];
    expect(setArg.stats).toEqual({ feeds: 3 });
    expect(setArg.error).toBeNull();
    expect(setArg.finished_at).toBeDefined();
  });

  it('finishRun records an error message when one is given', async () => {
    updateChain.where.mockResolvedValueOnce(undefined);
    const repo = new RssRepository(mockDb as never);

    await repo.finishRun('run-1', {}, 'boom');

    expect(updateChain.set.mock.calls[0][0].error).toBe('boom');
  });
});

describe('RssRepository.countSelectedToday', () => {
  beforeEach(resetDb);

  it('returns a per-category map of today’s selections', async () => {
    mockDb.execute.mockResolvedValueOnce({
      rows: [
        { category: 'new_funding', count: '4' },
        { category: 'ma_partnerships', count: '25' },
      ],
    });
    const repo = new RssRepository(mockDb as never);

    expect(await repo.countSelectedToday()).toEqual({
      new_funding: 4,
      ma_partnerships: 25,
    });
  });

  it('counts only rows selected since the start of the UTC day', async () => {
    mockDb.execute.mockResolvedValueOnce({ rows: [] });
    const repo = new RssRepository(mockDb as never);

    await repo.countSelectedToday();

    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain("date_trunc('day', now() AT TIME ZONE 'UTC')");
    expect(text).toContain("relevance = 'selected'");
  });
});

describe('RssRepository.applyClassifications', () => {
  beforeEach(resetDb);

  it('does nothing for an empty decision list', async () => {
    const repo = new RssRepository(mockDb as never);
    await repo.applyClassifications([]);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('writes every decision in one statement', async () => {
    const repo = new RssRepository(mockDb as never);

    await repo.applyClassifications([
      { id: 'i1', relevance: 'selected', score: 0.9, labels: { companies: [], topics: [], reason: 'r' } },
      { id: 'i2', relevance: 'rejected', score: 0.1, labels: { companies: [], topics: [], reason: 'r' } },
    ]);

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain('UPDATE rss.items');
    expect(text).toContain('jsonb_to_recordset');
  });

  it('queues selected items for content fetching and leaves rejected ones alone', async () => {
    const repo = new RssRepository(mockDb as never);

    await repo.applyClassifications([
      { id: 'i1', relevance: 'selected', score: 0.9, labels: { companies: [], topics: [], reason: 'r' } },
    ]);

    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain("WHEN u.relevance = 'selected' THEN 'pending'");
  });
});

describe('RssRepository content bookkeeping', () => {
  beforeEach(resetDb);

  it('recordContentSuccess stores the text and stamps the fetch time', async () => {
    updateChain.where.mockResolvedValueOnce(undefined);
    const repo = new RssRepository(mockDb as never);

    await repo.recordContentSuccess('i1', 'body');

    const setArg = updateChain.set.mock.calls[0][0];
    expect(setArg.content_text).toBe('body');
    expect(setArg.content_status).toBe('fetched');
    expect(setArg.content_error).toBeNull();
  });

  it('recordContentFailure increments attempts and only gives up at the budget', async () => {
    mockDb.execute.mockResolvedValueOnce({ rows: [] });
    const repo = new RssRepository(mockDb as never);

    await repo.recordContentFailure('i1', 'http 403');

    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain('content_attempts + 1');
    expect(text).toContain("'failed'");
    expect(text).toContain("'pending'");
  });
});

describe('RssRepository translation bookkeeping', () => {
  beforeEach(resetDb);

  it('listPendingTranslation queues only selected items with a resolved content fetch', async () => {
    mockDb.execute.mockResolvedValueOnce({ rows: [] });
    const repo = new RssRepository(mockDb as never);

    await repo.listPendingTranslation(15);

    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain("relevance = 'selected'");
    // 'failed' is included on purpose: such an item has only a title and a
    // summary, and a Japanese headline is exactly as unreadable as a
    // Japanese article.
    expect(text).toContain("content_status IN ('fetched', 'failed')");
    expect(text).toContain("translation_status IN ('none', 'pending')");
    expect(text).toContain('ORDER BY ingested_at ASC');
  });

  it('recordTranslationSuccess writes the *_en columns and leaves the originals alone', async () => {
    // The reading pane's "display in original language" toggle is only
    // possible because nothing here overwrites `title`/`summary`/`content_text`.
    updateChain.where.mockResolvedValueOnce(undefined);
    const repo = new RssRepository(mockDb as never);

    await repo.recordTranslationSuccess('i1', {
      language: 'ja',
      title: 'Title',
      summary: 'Summary',
      content: 'Body',
    });

    const setArg = updateChain.set.mock.calls[0][0];
    expect(setArg).toMatchObject({
      language: 'ja',
      title_en: 'Title',
      summary_en: 'Summary',
      content_text_en: 'Body',
      translation_status: 'translated',
      translation_error: null,
    });
    expect(setArg.title).toBeUndefined();
    expect(setArg.summary).toBeUndefined();
    expect(setArg.content_text).toBeUndefined();
  });

  it('markTranslationNotNeeded settles a whole batch in ONE statement', async () => {
    // The English majority is the hot path here (DETECT_LIMIT is 200), so a
    // loop of UPDATEs would be a write-side N+1.
    mockDb.execute.mockResolvedValueOnce({ rows: [] });
    const repo = new RssRepository(mockDb as never);

    await repo.markTranslationNotNeeded([
      { id: 'i1', language: 'en' },
      { id: 'i2', language: null },
    ]);

    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain('jsonb_to_recordset');
    expect(text).toContain("translation_status = 'not_needed'");
    // A null language travels as null rather than a guessed 'en' — the
    // detector reports null when the text is too short to judge, and
    // recording 'en' would state as fact something never established.
    expect(text).toContain('"language":null');
  });

  it('markTranslationNotNeeded does nothing for an empty batch', async () => {
    const repo = new RssRepository(mockDb as never);
    await repo.markTranslationNotNeeded([]);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('recordTranslationFailure increments attempts and only gives up at the budget', async () => {
    mockDb.execute.mockResolvedValueOnce({ rows: [] });
    const repo = new RssRepository(mockDb as never);

    await repo.recordTranslationFailure('i1', 'overloaded');

    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain('translation_attempts + 1');
    expect(text).toContain("'failed'");
    expect(text).toContain("'pending'");
  });

  it('recordTranslationFailure truncates a runaway error message', async () => {
    mockDb.execute.mockResolvedValueOnce({ rows: [] });
    const repo = new RssRepository(mockDb as never);

    await repo.recordTranslationFailure('i1', 'x'.repeat(900));

    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain('x'.repeat(500));
    expect(text).not.toContain('x'.repeat(501));
  });
});

describe('RssRepository.listPendingEmbedding', () => {
  beforeEach(resetDb);

  it('waits for translation to resolve before embedding an item', async () => {
    // Both halves of hybrid search are English, so embedding a Japanese body
    // would bury the item in the index. 'failed' IS embeddable — from the
    // original text — which is what stops the gate from deadlocking.
    mockDb.execute.mockResolvedValueOnce({ rows: [] });
    const repo = new RssRepository(mockDb as never);

    await repo.listPendingEmbedding(25);

    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain("translation_status IN ('not_needed', 'translated', 'failed')");
    expect(text).toContain('embedded_at IS NULL');
  });

  it('selects the translated columns so the embedder can prefer English', async () => {
    mockDb.execute.mockResolvedValueOnce({ rows: [] });
    const repo = new RssRepository(mockDb as never);

    await repo.listPendingEmbedding(25);

    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain('title_en');
    expect(text).toContain('summary_en');
    expect(text).toContain('content_text_en');
  });
});

describe('RssRepository.saveChunks', () => {
  beforeEach(resetDb);

  it('does nothing when there are no chunks', async () => {
    const repo = new RssRepository(mockDb as never);
    await repo.saveChunks('i1', []);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('numbers chunks sequentially and stamps the item as embedded', async () => {
    insertChain.onConflictDoNothing.mockResolvedValueOnce(undefined);
    updateChain.where.mockResolvedValueOnce(undefined);
    const repo = new RssRepository(mockDb as never);

    await repo.saveChunks('i1', [
      { text: 'a', embedding: [0.1] },
      { text: 'b', embedding: [0.2] },
    ]);

    const values = insertChain.values.mock.calls[0][0];
    expect(values.map((v: { chunk_index: number }) => v.chunk_index)).toEqual([0, 1]);
    expect(updateChain.set.mock.calls[0][0].embedded_at).toBeDefined();
  });

  it('is safe to re-run: chunk inserts ignore conflicts', async () => {
    insertChain.onConflictDoNothing.mockResolvedValueOnce(undefined);
    updateChain.where.mockResolvedValueOnce(undefined);
    const repo = new RssRepository(mockDb as never);

    await repo.saveChunks('i1', [{ text: 'a', embedding: [0.1] }]);

    expect(insertChain.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });
});
