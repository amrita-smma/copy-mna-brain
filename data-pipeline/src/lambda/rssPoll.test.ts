import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  loadSecretsFromSsm: vi.fn().mockResolvedValue(undefined),
  createLambdaDb: vi.fn(),
  pgClientEnd: vi.fn().mockResolvedValue(undefined),
  listActiveFeeds: vi.fn(),
  insertNewItems: vi.fn(),
  applyFeedHealth: vi.fn().mockResolvedValue(undefined),
  startRun: vi.fn().mockResolvedValue('run-1'),
  finishRun: vi.fn().mockResolvedValue(undefined),
  fetchFeed: vi.fn(),
  writeBronze: vi.fn().mockResolvedValue([]),
}));

vi.mock('../secrets', () => ({ loadSecretsFromSsm: mocks.loadSecretsFromSsm }));
vi.mock('../db', () => ({ createLambdaDb: mocks.createLambdaDb }));
vi.mock('../repositories', () => ({
  RssRepository: class {
    listActiveFeeds = mocks.listActiveFeeds;
    insertNewItems = mocks.insertNewItems;
    applyFeedHealth = mocks.applyFeedHealth;
    startRun = mocks.startRun;
    finishRun = mocks.finishRun;
  },
}));
vi.mock('../lib/rssFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/rssFetch')>();
  return { ...actual, fetchFeed: mocks.fetchFeed };
});
vi.mock('../lib/rssBronze', () => ({ writeBronze: mocks.writeBronze }));

import { handler } from './rssPoll';

const RSS_XML = `<?xml version="1.0"?><rss version="2.0"><channel>
  <item><title>Acme raises</title><link>https://example.com/a</link><guid>g-a</guid></item>
  <item><title>Beta merges</title><link>https://example.com/b</link><guid>g-b</guid></item>
</channel></rss>`;

function feed(id: string) {
  return {
    id,
    category: 'new_funding',
    source_name: `Source ${id}`,
    feed_url: `https://example.com/${id}/rss`,
    region: 'US',
    tier: 'curated',
    etag: null,
    last_modified: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createLambdaDb.mockResolvedValue({ pgClient: { end: mocks.pgClientEnd }, db: {} });
  mocks.startRun.mockResolvedValue('run-1');
  mocks.writeBronze.mockResolvedValue([]);
  mocks.insertNewItems.mockImplementation(async (items: unknown[]) => items);
});

describe('rss-poll handler', () => {
  it('parses fresh feeds and reports the new items', async () => {
    mocks.listActiveFeeds.mockResolvedValue([feed('f1')]);
    mocks.fetchFeed.mockResolvedValue({
      kind: 'fresh',
      xml: RSS_XML,
      etag: 'W/"1"',
      lastModified: null,
    });

    const out = await handler({}, {});

    expect(out.ok).toBe(true);
    expect(out.result.feeds_polled).toBe(1);
    expect(out.result.items_parsed).toBe(2);
    expect(out.result.items_new).toBe(2);
  });

  it('counts a 304 as unchanged and healthy, without parsing', async () => {
    mocks.listActiveFeeds.mockResolvedValue([feed('f1')]);
    mocks.fetchFeed.mockResolvedValue({ kind: 'unchanged' });

    const out = await handler({}, {});

    expect(out.result.unchanged).toBe(1);
    expect(out.result.items_parsed).toBe(0);
    expect(mocks.applyFeedHealth).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'f1', ok: true }),
    ]);
  });

  it('marks a fetch failure unhealthy without aborting the run', async () => {
    mocks.listActiveFeeds.mockResolvedValue([feed('f1'), feed('f2')]);
    mocks.fetchFeed
      .mockResolvedValueOnce({ kind: 'failed', reason: 'http 503' })
      .mockResolvedValueOnce({ kind: 'fresh', xml: RSS_XML, etag: null, lastModified: null });

    const out = await handler({}, {});

    expect(out.ok).toBe(true);
    expect(out.result.failed).toBe(1);
    expect(out.result.items_new).toBe(2);
    const health = mocks.applyFeedHealth.mock.calls[0][0];
    expect(health).toContainEqual(expect.objectContaining({ id: 'f1', ok: false }));
    expect(health).toContainEqual(expect.objectContaining({ id: 'f2', ok: true }));
  });

  it('treats unparseable XML as a feed failure, not a crash', async () => {
    mocks.listActiveFeeds.mockResolvedValue([feed('f1')]);
    mocks.fetchFeed.mockResolvedValue({
      kind: 'fresh',
      xml: 'not xml at all',
      etag: null,
      lastModified: null,
    });

    const out = await handler({}, {});

    expect(out.ok).toBe(true);
    expect(out.result.failed).toBe(1);
    expect(mocks.applyFeedHealth.mock.calls[0][0][0]).toMatchObject({ id: 'f1', ok: false });
  });

  it('archives new items to bronze before returning', async () => {
    mocks.listActiveFeeds.mockResolvedValue([feed('f1')]);
    mocks.fetchFeed.mockResolvedValue({ kind: 'fresh', xml: RSS_XML, etag: null, lastModified: null });
    mocks.writeBronze.mockResolvedValue(['bronze/category=new_funding/ingest_date=x/run_y.ndjson']);

    const out = await handler({}, {});

    expect(mocks.writeBronze).toHaveBeenCalledTimes(1);
    expect(mocks.writeBronze.mock.calls[0][0]).toHaveLength(2);
    expect(out.result.bronze_keys).toHaveLength(1);
  });

  it('only archives genuinely new items, not everything parsed', async () => {
    mocks.listActiveFeeds.mockResolvedValue([feed('f1')]);
    mocks.fetchFeed.mockResolvedValue({ kind: 'fresh', xml: RSS_XML, etag: null, lastModified: null });
    // The DB says only the first hash was new.
    mocks.insertNewItems.mockImplementation(async (items: { item_hash: string }[]) => [items[0]]);

    const out = await handler({}, {});

    expect(out.result.items_parsed).toBe(2);
    expect(out.result.items_new).toBe(1);
    expect(mocks.writeBronze.mock.calls[0][0]).toHaveLength(1);
  });

  it('records the run and always closes the pg client', async () => {
    mocks.listActiveFeeds.mockResolvedValue([]);

    await handler({}, {});

    expect(mocks.startRun).toHaveBeenCalledWith('poll');
    expect(mocks.finishRun).toHaveBeenCalledWith('run-1', expect.any(Object), null);
    expect(mocks.pgClientEnd).toHaveBeenCalledTimes(1);
  });

  it('records the error on the run row and rethrows when the poll blows up', async () => {
    mocks.listActiveFeeds.mockRejectedValue(new Error('db down'));

    await expect(handler({}, {})).rejects.toThrow('db down');

    expect(mocks.finishRun).toHaveBeenCalledWith('run-1', expect.any(Object), 'db down');
    expect(mocks.pgClientEnd).toHaveBeenCalledTimes(1);
  });
});
