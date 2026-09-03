/**
 * Polite, conditional feed fetching.
 *
 * Every request carries If-None-Match / If-Modified-Since from the last poll,
 * so an unchanged feed costs a 304 rather than a full download + parse. This
 * is what makes a 30-minute cadence over 263 feeds cheap.
 */
export const FETCH_TIMEOUT_MS = 20_000;
export const POLL_CONCURRENCY = 12;
export const USER_AGENT = 'Mozilla/5.0 (compatible; MnaBrainRSS/1.0; +https://mna-brain.local)';

export interface FeedRowWithValidators {
  id: string;
  feed_url: string;
  etag: string | null;
  last_modified: string | null;
}

export type FetchOutcome =
  | { kind: 'fresh'; xml: string; etag: string | null; lastModified: string | null }
  | { kind: 'unchanged' }
  | { kind: 'failed'; reason: string };

export interface FetchDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function fetchFeed(
  feed: FeedRowWithValidators,
  deps: FetchDeps = {},
): Promise<FetchOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS;

  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
  };
  if (feed.etag) headers['If-None-Match'] = feed.etag;
  if (feed.last_modified) headers['If-Modified-Since'] = feed.last_modified;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(feed.feed_url, { headers, signal: controller.signal, redirect: 'follow' });

    if (res.status === 304) return { kind: 'unchanged' };
    if (res.status >= 400) return { kind: 'failed', reason: `http ${res.status}` };

    const xml = await res.text();
    if (xml.trim().length === 0) return { kind: 'failed', reason: 'empty body' };

    return {
      kind: 'fresh',
      xml,
      etag: res.headers.get('ETag'),
      lastModified: res.headers.get('Last-Modified'),
    };
  } catch (err) {
    // A dead feed must never take the whole run down — every failure is data
    // for the health counters instead of an exception.
    const reason = err instanceof Error ? err.message : String(err);
    return { kind: 'failed', reason: reason.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bounded-concurrency map preserving input order. A hand-rolled worker pool
 * rather than p-limit: one fewer runtime dependency to bundle into a Lambda.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}
