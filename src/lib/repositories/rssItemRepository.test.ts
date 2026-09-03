import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RssItemRepository } from './rssItemRepository';

/**
 * Renders a Drizzle `SQL` (or a raw chunk/value inside one) back to text for
 * assertions. Recurses into nested `SQL` fragments — e.g. one produced by
 * `and(...)`, `sql.join(...)`, or a ternary that returns `sql\`...\`` — by
 * walking their own `queryChunks`, not just the top-level chunk array. A
 * non-recursive version of this helper can miss text that's actually in the
 * generated query, which would let a broken nested condition pass silently.
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
