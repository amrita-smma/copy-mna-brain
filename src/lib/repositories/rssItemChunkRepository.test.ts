import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RssItemChunkRepository } from './rssItemChunkRepository';

/**
 * Renders a Drizzle `SQL` (or a raw chunk/value inside one) back to text for
 * assertions. Recurses into nested `SQL` fragments — e.g. one produced by a
 * ternary that returns `sql\`...\`` or by `sql.join(...)` — by walking their
 * own `queryChunks`, not just the top-level chunk array. A non-recursive
 * version of this helper can miss text that's actually in the generated
 * query, which would fail a correct implementation just because the SQL
 * happened to be composed with a nested fragment instead of `.append()`.
 */
function sqlText(q: unknown): string {
  if (q === null || q === undefined) return '';
  if (typeof q === 'string' || typeof q === 'number') return String(q);
  if (Array.isArray(q)) return q.map(sqlText).join('');
  if (typeof q === 'object') {
    const withChunks = q as { queryChunks?: unknown[] };
    if (Array.isArray(withChunks.queryChunks)) {
      return withChunks.queryChunks.map(sqlText).join('');
    }
    if ('value' in q) {
      return sqlText((q as { value: unknown }).value);
    }
  }
  return '';
}

const mockDb = { execute: vi.fn() };
const embedding = Array.from({ length: 1024 }, () => 0.01);

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.execute.mockResolvedValue({ rows: [] });
});

describe('RssItemChunkRepository.vectorSearch', () => {
  it('orders by cosine distance and returns the hits', async () => {
    mockDb.execute.mockResolvedValueOnce({
      rows: [{ item_id: 'i1', chunk_text: 'Acme raised $40m', distance: 0.12 }],
    });
    const repo = new RssItemChunkRepository(mockDb as never);

    const hits = await repo.vectorSearch(embedding, 5, {});

    expect(hits).toEqual([{ item_id: 'i1', chunk_text: 'Acme raised $40m', distance: 0.12 }]);
    expect(sqlText(mockDb.execute.mock.calls[0][0])).toContain('<=>');
  });

  it('joins to items so category and date filters apply inside the same statement', async () => {
    const repo = new RssItemChunkRepository(mockDb as never);

    await repo.vectorSearch(embedding, 5, { categories: ['new_funding'], from: '2026-09-01T00:00:00Z' });

    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain('JOIN rss.items');
    expect(text).toContain('category');
    expect(text).toContain('published_at');
  });

  it('deduplicates to the best chunk per item so one article cannot fill the page', async () => {
    const repo = new RssItemChunkRepository(mockDb as never);
    await repo.vectorSearch(embedding, 5, {});
    expect(sqlText(mockDb.execute.mock.calls[0][0])).toContain('DISTINCT ON (c.item_id)');
  });

  it('rejects a vector of the wrong width rather than querying with it', async () => {
    const repo = new RssItemChunkRepository(mockDb as never);
    await expect(repo.vectorSearch([0.1, 0.2], 5, {})).rejects.toThrow(/1024/);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('returns [] without querying when a filter is explicitly empty', async () => {
    const repo = new RssItemChunkRepository(mockDb as never);
    expect(await repo.vectorSearch(embedding, 5, { categories: [] })).toEqual([]);
    expect(mockDb.execute).not.toHaveBeenCalled();
  });

  it('clamps topK to a sane ceiling', async () => {
    const repo = new RssItemChunkRepository(mockDb as never);
    await repo.vectorSearch(embedding, 10_000, {});
    expect(sqlText(mockDb.execute.mock.calls[0][0])).toContain('50');
  });

  it('adds a relevance condition on the joined item when selectedOnly is set', async () => {
    const repo = new RssItemChunkRepository(mockDb as never);
    await repo.vectorSearch(embedding, 5, { selectedOnly: true });

    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).toContain('i.relevance');
    expect(text).toContain('selected');
  });

  it('omits the relevance condition when selectedOnly is not set', async () => {
    const repo = new RssItemChunkRepository(mockDb as never);
    await repo.vectorSearch(embedding, 5, {});

    const text = sqlText(mockDb.execute.mock.calls[0][0]);
    expect(text).not.toContain('i.relevance');
  });

  /**
   * Regression test for the top-K bug: `LIMIT` must apply to the OUTER
   * query — the one ordered by `distance` — not to the inner
   * `DISTINCT ON (c.item_id) ... ORDER BY c.item_id` de-duplication
   * subquery. Applying it to the inner query returns the k
   * lexicographically-smallest item UUIDs (via the `ORDER BY c.item_id`
   * DISTINCT ON requires), not the k nearest by distance — confirmed
   * against the live DB, where the old shipping query's `LIMIT 2`
   * returned the two FURTHEST of 5 probe chunks (distances 0.80388 and
   * 0.55279) instead of the two nearest (0.01942 and 0.10557).
   *
   * A shape assertion alone (e.g. "the text contains DISTINCT ON") can't
   * tell a correct query from the buggy one, since both contain that
   * clause. This test instead locates the inner de-duplicating subquery
   * (bounded by the first `(` ... matching `)` after `DISTINCT ON`) and
   * asserts `LIMIT` and the distance-ordered `ORDER BY` appear only after
   * that subquery closes.
   */
  it('applies LIMIT to the distance-ordered outer query, not the item_id-ordered dedup subquery', async () => {
    const repo = new RssItemChunkRepository(mockDb as never);
    await repo.vectorSearch(embedding, 5, {});

    const text = sqlText(mockDb.execute.mock.calls[0][0]).replace(/\s+/g, ' ');

    const distinctOnIndex = text.indexOf('DISTINCT ON (c.item_id)');
    expect(distinctOnIndex).toBeGreaterThanOrEqual(0);

    // Find the inner subquery's closing paren by walking parens forward
    // from the first '(' after DISTINCT ON's own dedup-column parens.
    const innerOrderByIndex = text.indexOf('ORDER BY c.item_id', distinctOnIndex);
    expect(innerOrderByIndex).toBeGreaterThan(distinctOnIndex);

    let depth = 1; // one open paren from "FROM (" that starts the subquery
    let cursor = text.indexOf('(', text.indexOf('FROM (', distinctOnIndex)) + 1;
    while (depth > 0 && cursor < text.length) {
      if (text[cursor] === '(') depth++;
      if (text[cursor] === ')') depth--;
      cursor++;
    }
    const subqueryEnd = cursor; // index just past the subquery's closing ')'

    const outerLimitIndex = text.indexOf('LIMIT', subqueryEnd);
    const outerOrderByIndex = text.indexOf('ORDER BY distance', subqueryEnd);

    expect(outerOrderByIndex).toBeGreaterThanOrEqual(subqueryEnd);
    expect(outerLimitIndex).toBeGreaterThan(outerOrderByIndex);
    // The buggy form put LIMIT before the subquery closed (right after the
    // item_id-ordered ORDER BY); guard against that regressing back in.
    expect(text.indexOf('LIMIT', innerOrderByIndex)).toBeGreaterThanOrEqual(subqueryEnd);
  });

  it('returns hits already ordered by ascending distance from the query, without re-sorting in JS', async () => {
    mockDb.execute.mockResolvedValueOnce({
      rows: [
        { item_id: 'near', chunk_text: 'closest', distance: 0.02 },
        { item_id: 'far', chunk_text: 'furthest of the two', distance: 0.8 },
      ],
    });
    const repo = new RssItemChunkRepository(mockDb as never);

    const hits = await repo.vectorSearch(embedding, 2, {});

    expect(hits.map((h) => h.item_id)).toEqual(['near', 'far']);
  });
});
