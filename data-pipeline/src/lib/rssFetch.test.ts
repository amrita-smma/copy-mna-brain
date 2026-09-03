import { describe, it, expect, vi } from 'vitest';
import { fetchFeed, mapWithConcurrency, USER_AGENT } from './rssFetch';

const feed = {
  id: 'f1',
  feed_url: 'https://example.com/rss',
  etag: null as string | null,
  last_modified: null as string | null,
};

function response(init: {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}): Response {
  return {
    status: init.status,
    ok: init.status >= 200 && init.status < 300,
    text: async () => init.body ?? '',
    headers: { get: (k: string) => init.headers?.[k.toLowerCase()] ?? null },
  } as unknown as Response;
}

describe('fetchFeed', () => {
  it('returns the body and validators on a 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({
        status: 200,
        body: '<rss/>',
        headers: { etag: 'W/"abc"', 'last-modified': 'Tue, 02 Sep 2026 00:00:00 GMT' },
      }),
    );

    const out = await fetchFeed(feed, { fetchImpl });

    expect(out).toEqual({
      kind: 'fresh',
      xml: '<rss/>',
      etag: 'W/"abc"',
      lastModified: 'Tue, 02 Sep 2026 00:00:00 GMT',
    });
  });

  it('sends the stored validators as conditional request headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ status: 304 }));

    await fetchFeed(
      { ...feed, etag: 'W/"abc"', last_modified: 'Mon, 01 Sep 2026 00:00:00 GMT' },
      { fetchImpl },
    );

    const headers = fetchImpl.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['If-None-Match']).toBe('W/"abc"');
    expect(headers['If-Modified-Since']).toBe('Mon, 01 Sep 2026 00:00:00 GMT');
    expect(headers['User-Agent']).toBe(USER_AGENT);
  });

  it('reports 304 as unchanged, which still counts as a healthy poll', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ status: 304 }));
    expect(await fetchFeed(feed, { fetchImpl })).toEqual({ kind: 'unchanged' });
  });

  it('reports an HTTP error as failed with the status in the reason', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ status: 503 }));
    const out = await fetchFeed(feed, { fetchImpl });
    expect(out).toEqual({ kind: 'failed', reason: 'http 503' });
  });

  it('reports a thrown network error as failed rather than propagating it', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const out = await fetchFeed(feed, { fetchImpl });
    expect(out).toEqual({ kind: 'failed', reason: 'ECONNRESET' });
  });

  it('reports an empty 200 body as failed so it is not parsed as a valid feed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ status: 200, body: '   ' }));
    expect(await fetchFeed(feed, { fetchImpl })).toEqual({ kind: 'failed', reason: 'empty body' });
  });
});

describe('mapWithConcurrency', () => {
  it('processes every item and preserves input order in the results', async () => {
    const out = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 2);
    expect(out).toEqual([2, 4, 6, 8, 10]);
  });

  it('never runs more than `limit` tasks at once', async () => {
    let active = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('returns [] for an empty input without calling the worker', async () => {
    const fn = vi.fn();
    expect(await mapWithConcurrency([], 4, fn)).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});
