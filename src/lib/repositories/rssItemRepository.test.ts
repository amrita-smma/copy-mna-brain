import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RssItemRepository } from './rssItemRepository';

/**
 * Renders a Drizzle `SQL` (or a raw chunk/value inside one) back to text for
 * assertions. Recurses into nested `SQL` fragments — e.g. one produced by
 * `and(...)`, `sql.join(...)`, or a ternary that returns `sql\`...\`` — by
 * walking their own `queryChunks`, not just the top-level chunk array. A
 * non-recursive version of this helper can miss text that's actually in the
 * generated query, which would let a broken nested condition pass silently.
 *
 * It also renders the two node kinds a bare `queryChunks` walk returns '' for:
 * an aliased fragment (`sql\`...\`.as('x')`, which holds its fragment under
 * `.sql`) and a column reference (which carries its own `.name`). Without
 * those, any assertion about an expression built from columns — such as the
 * trusted-date CASE below — silently compares against an empty string and
 * passes no matter what the query actually says.
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
    // `SQL.Aliased` — unwrap to the fragment it wraps.
    const aliased = q as { sql?: unknown };
    if (aliased.sql !== undefined) return sqlText(aliased.sql);
    // A `Column`: render as its column name so expressions read back.
    const column = q as { name?: unknown };
    if (typeof column.name === 'string') return column.name;
    if ('value' in q) {
      return sqlText((q as { value: unknown }).value);
    }
  }
  return '';
}

const selectChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockReturnThis(),
  groupBy: vi.fn().mockReturnThis(),
  limit: vi.fn(),
};

const mockDb = {
  select: vi.fn().mockReturnValue(selectChain),
  execute: vi.fn().mockResolvedValue({ rows: [] }),
};

function resetDb() {
  vi.clearAllMocks();
  mockDb.select.mockReturnValue(selectChain);
  mockDb.execute.mockResolvedValue({ rows: [] });
  selectChain.from.mockReturnThis();
  selectChain.where.mockReturnThis();
  selectChain.orderBy.mockReturnThis();
  selectChain.groupBy.mockReturnThis();
}

describe('RssItemRepository.listItems', () => {
  let repo: RssItemRepository;

  beforeEach(() => {
    resetDb();
    repo = new RssItemRepository(mockDb as never);
  });

  it('returns rows ordered newest-first with a bounded page size', async () => {
    selectChain.limit.mockResolvedValueOnce([{ id: 'i1' }]);

    const rows = await repo.listItems({});

    expect(rows).toEqual([{ id: 'i1' }]);
    expect(selectChain.orderBy).toHaveBeenCalledTimes(1);
    expect(selectChain.limit).toHaveBeenCalledWith(50);
  });

  it('clamps an absurd page size instead of trusting the caller', async () => {
    selectChain.limit.mockResolvedValueOnce([]);
    await repo.listItems({ limit: 100000 });
    expect(selectChain.limit).toHaveBeenCalledWith(100);
  });

  it('returns [] without querying when a filter array is explicitly empty', async () => {
    expect(await repo.listItems({ categories: [] })).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('adds a WHERE clause for each supplied filter', async () => {
    selectChain.limit.mockResolvedValueOnce([]);

    await repo.listItems({
      categories: ['new_funding'],
      sourceNames: ['Mint'],
      regions: ['India'],
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-02T00:00:00Z',
      selectedOnly: true,
    });

    expect(selectChain.where).toHaveBeenCalledTimes(1);
  });

  it('applies keyset pagination when a cursor is given', async () => {
    selectChain.limit.mockResolvedValueOnce([]);

    await repo.listItems({ cursor: { publishedAt: '2026-09-01T00:00:00Z', id: 'i9' } });

    expect(selectChain.where).toHaveBeenCalledTimes(1);
    const condition = sqlText(selectChain.where.mock.calls[0][0]);
    // The row-comparison half of the keyset predicate.
    expect(condition).toContain('<');
  });

  it('still admits undated rows once paging past the dated bucket', async () => {
    selectChain.limit.mockResolvedValueOnce([]);

    // A cursor with a non-null `publishedAt` means we're paging within (or
    // past) the dated rows. `ORDER BY published_at DESC NULLS LAST` sorts
    // every undated row after every dated row, so the very next page must
    // still admit the entire undated bucket — otherwise a plain row
    // comparison `(published_at, id) < (cursor)` evaluates to NULL (and is
    // therefore excluded) for every row whose published_at is NULL, which
    // makes undated items permanently unreachable the moment a reader pages
    // past the last dated row.
    await repo.listItems({ cursor: { publishedAt: '2026-09-01T00:00:00Z', id: 'i9' } });

    const condition = sqlText(selectChain.where.mock.calls[0][0]);
    expect(condition).toContain('IS NULL');
  });

  it('never selects content_text in the list projection', async () => {
    selectChain.limit.mockResolvedValueOnce([]);
    await repo.listItems({});
    const projection = mockDb.select.mock.calls[0][0] as Record<string, unknown>;
    expect(projection).not.toHaveProperty('content_text');
    expect(projection).toHaveProperty('title');
  });
});

describe('RssItemRepository.findByIds', () => {
  let repo: RssItemRepository;

  beforeEach(() => {
    resetDb();
    repo = new RssItemRepository(mockDb as never);
  });

  it('returns [] without hitting the DB when the id list is empty', async () => {
    expect(await repo.findByIds([])).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('fetches every id in a single query', async () => {
    selectChain.where.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }]);

    const rows = await repo.findByIds(['a', 'b']);

    expect(rows).toHaveLength(2);
    expect(mockDb.select).toHaveBeenCalledTimes(1);
  });
});

describe('RssItemRepository.textSearch', () => {
  let repo: RssItemRepository;

  beforeEach(() => {
    resetDb();
    repo = new RssItemRepository(mockDb as never);
  });

  it('matches title, authors and source_name', async () => {
    selectChain.limit.mockResolvedValueOnce([]);

    await repo.textSearch('acme', {}, 20);

    expect(selectChain.where).toHaveBeenCalledTimes(1);
    expect(selectChain.limit).toHaveBeenCalledWith(20);
  });

  it('returns [] for a blank query without querying', async () => {
    expect(await repo.textSearch('   ', {}, 20)).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});

describe('RssItemRepository.listFilterOptions', () => {
  beforeEach(resetDb);

  it('returns the distinct facet combinations in one grouped query', async () => {
    mockDb.execute.mockResolvedValueOnce({
      rows: [{ category: 'new_funding', source_name: 'Mint', region: 'India' }],
    });
    const repo = new RssItemRepository(mockDb as never);

    const options = await repo.listFilterOptions();

    expect(options).toHaveLength(1);
    expect(mockDb.execute).toHaveBeenCalledTimes(1);
    expect(sqlText(mockDb.execute.mock.calls[0][0])).toContain('DISTINCT');
  });
});

/**
 * A feed's `<pubDate>` is publisher-controlled and sometimes lands in the
 * future (timezone bugs, scheduled posts, bad clocks). Such a row would pin
 * itself to the top of a newest-first feed until real time caught up, so
 * every read path substitutes `ingested_at` for a publish date the row claims
 * is later than its own ingestion. These tests assert the CASE expression is
 * actually in the emitted SQL on each of those paths — the mock DB never runs
 * it, so the guarantee is "the query says this", not "Postgres computed this".
 */
describe('RssItemRepository effective published_at', () => {
  let repo: RssItemRepository;

  /** The trusted-date CASE, insensitive to whitespace/newlines in the template. */
  const EFFECTIVE_SQL =
    /CASE\s+WHEN\s+[\s\S]*published_at[\s\S]*>[\s\S]*ingested_at[\s\S]*THEN[\s\S]*ingested_at[\s\S]*ELSE[\s\S]*published_at[\s\S]*END/;

  beforeEach(() => {
    resetDb();
    repo = new RssItemRepository(mockDb as never);
  });

  it('orders listItems by the trusted date, not the raw published_at', async () => {
    selectChain.limit.mockResolvedValueOnce([]);

    await repo.listItems({});

    expect(sqlText(selectChain.orderBy.mock.calls[0][0])).toMatch(EFFECTIVE_SQL);
  });

  it('projects the trusted date under the published_at key so callers need no fallback', async () => {
    selectChain.limit.mockResolvedValueOnce([]);

    await repo.listItems({});

    const projection = mockDb.select.mock.calls[0][0] as Record<string, unknown>;
    expect(sqlText(projection.published_at)).toMatch(EFFECTIVE_SQL);
    // `ingested_at` is still exposed on its own, untouched.
    expect(sqlText(projection.published_at)).not.toBe(sqlText(projection.ingested_at));
  });

  it('compares the keyset cursor against the trusted date so paging matches the order', async () => {
    selectChain.limit.mockResolvedValueOnce([]);

    await repo.listItems({ cursor: { publishedAt: '2026-01-01T00:00:00Z', id: 'i9' } });

    expect(sqlText(selectChain.where.mock.calls[0][0])).toMatch(EFFECTIVE_SQL);
  });

  it('applies the undated-bucket cursor branch against the trusted date too', async () => {
    selectChain.limit.mockResolvedValueOnce([]);

    await repo.listItems({ cursor: { publishedAt: null, id: 'i9' } });

    const where = sqlText(selectChain.where.mock.calls[0][0]);
    expect(where).toMatch(EFFECTIVE_SQL);
    expect(where).toContain('IS NULL');
  });

  it('filters a from/to date range on the trusted date, not the publisher claim', async () => {
    selectChain.limit.mockResolvedValueOnce([]);

    await repo.listItems({ from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' });

    expect(sqlText(selectChain.where.mock.calls[0][0])).toMatch(EFFECTIVE_SQL);
  });

  it('orders textSearch by the trusted date as well', async () => {
    selectChain.limit.mockResolvedValueOnce([]);

    await repo.textSearch('acquisition', {}, 10);

    expect(sqlText(selectChain.orderBy.mock.calls[0][0])).toMatch(EFFECTIVE_SQL);
  });

  it('overrides published_at on the single-item detail read', async () => {
    selectChain.limit.mockResolvedValueOnce([{ id: 'i1' }]);

    await repo.findById('i1');

    const projection = mockDb.select.mock.calls[0][0] as Record<string, unknown>;
    // Detail selects every column, so assert the override landed AND that
    // unrelated columns (the ones the list projection omits) came along.
    expect(sqlText(projection.published_at)).toMatch(EFFECTIVE_SQL);
    expect(projection.content_text).toBeDefined();
    expect(projection.llm_labels).toBeDefined();
  });

  it('hydrates search hits through the same trusted projection', async () => {
    selectChain.where.mockResolvedValueOnce([{ id: 'i1' }]);

    await repo.findByIds(['i1']);

    const projection = mockDb.select.mock.calls[0][0] as Record<string, unknown>;
    expect(sqlText(projection.published_at)).toMatch(EFFECTIVE_SQL);
  });
});
