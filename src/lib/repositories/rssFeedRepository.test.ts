import { describe, it, expect, vi, beforeEach } from 'vitest';
import { rssFeeds } from '@/lib/db/schema';
import { RssFeedRepository } from './rssFeedRepository';

const selectChain = {
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn(),
  limit: vi.fn(),
};
const insertChain = {
  values: vi.fn().mockReturnThis(),
  onConflictDoUpdate: vi.fn().mockReturnThis(),
  returning: vi.fn(),
};
const updateChain = {
  set: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  returning: vi.fn(),
};
const deleteChain = {
  where: vi.fn(),
};

const mockDb = {
  select: vi.fn().mockReturnValue(selectChain),
  insert: vi.fn().mockReturnValue(insertChain),
  update: vi.fn().mockReturnValue(updateChain),
  delete: vi.fn().mockReturnValue(deleteChain),
};

function resetDb() {
  vi.clearAllMocks();
  mockDb.select.mockReturnValue(selectChain);
  mockDb.insert.mockReturnValue(insertChain);
  mockDb.update.mockReturnValue(updateChain);
  mockDb.delete.mockReturnValue(deleteChain);
  selectChain.from.mockReturnThis();
  selectChain.where.mockReturnThis();
  insertChain.values.mockReturnThis();
  insertChain.onConflictDoUpdate.mockReturnThis();
  updateChain.set.mockReturnThis();
  updateChain.where.mockReturnThis();
}

describe('RssFeedRepository.list', () => {
  let repo: RssFeedRepository;

  beforeEach(() => {
    resetDb();
    repo = new RssFeedRepository(mockDb as never);
  });

  it('returns every feed ordered by category then source when no filters are given', async () => {
    selectChain.orderBy.mockResolvedValueOnce([{ id: 'f1' }]);

    const rows = await repo.list();

    expect(rows).toEqual([{ id: 'f1' }]);
    // No filters means no WHERE clause at all, not `WHERE true`.
    expect(selectChain.where).not.toHaveBeenCalled();
    expect(selectChain.orderBy).toHaveBeenCalledTimes(1);
  });

  it('applies a WHERE clause when categories are given', async () => {
    selectChain.orderBy.mockResolvedValueOnce([]);

    await repo.list({ categories: ['new_funding'] });

    expect(selectChain.where).toHaveBeenCalledTimes(1);
  });

  it('returns [] without querying when a filter array is empty', async () => {
    const rows = await repo.list({ categories: [] });

    expect(rows).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('applies a WHERE clause when statuses are given', async () => {
    selectChain.orderBy.mockResolvedValueOnce([]);

    await repo.list({ statuses: ['active'] });

    expect(selectChain.where).toHaveBeenCalledTimes(1);
  });

  it('returns [] without querying when the statuses filter array is empty', async () => {
    const rows = await repo.list({ statuses: [] });

    expect(rows).toEqual([]);
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});

describe('RssFeedRepository.bulkUpsert', () => {
  let repo: RssFeedRepository;

  beforeEach(() => {
    resetDb();
    repo = new RssFeedRepository(mockDb as never);
  });

  it('returns 0 without touching the DB for an empty batch', async () => {
    expect(await repo.bulkUpsert([])).toBe(0);
    expect(mockDb.insert).not.toHaveBeenCalled();
  });

  it('upserts on feed_url and returns the affected row count', async () => {
    insertChain.returning.mockResolvedValueOnce([{ id: 'f1' }, { id: 'f2' }]);

    const count = await repo.bulkUpsert([
      { category: 'new_funding', source_name: 'A', feed_url: 'https://a/rss' },
      { category: 'new_funding', source_name: 'B', feed_url: 'https://b/rss' },
    ]);

    expect(count).toBe(2);
    expect(insertChain.values).toHaveBeenCalledTimes(1);
    expect(insertChain.onConflictDoUpdate).toHaveBeenCalledTimes(1);
    // Defaults must be materialised so the CHECK constraints are satisfied.
    const values = insertChain.values.mock.calls[0][0];
    expect(values[0]).toMatchObject({ tier: 'curated', status: 'active' });
  });

  it('conflicts on feed_url and refreshes only editorial columns, never the pipeline-owned health columns', async () => {
    insertChain.returning.mockResolvedValueOnce([{ id: 'f1' }]);

    await repo.bulkUpsert([
      { category: 'new_funding', source_name: 'A', feed_url: 'https://a/rss' },
    ]);

    const conflictArg = insertChain.onConflictDoUpdate.mock.calls[0][0];
    expect(conflictArg.target).toBe(rssFeeds.feed_url);

    const setArg = conflictArg.set;
    // Editorial columns (plus updated_at) must be refreshed on conflict.
    expect(Object.keys(setArg).sort()).toEqual(
      ['category', 'source_name', 'region', 'tier', 'status', 'notes', 'updated_at'].sort(),
    );
    // The poller owns these — a re-import must never reset them, or every
    // feed would look like it needs re-downloading.
    for (const healthColumn of [
      'etag',
      'last_modified',
      'last_polled_at',
      'last_success_at',
      'consecutive_failures',
    ]) {
      expect(setArg).not.toHaveProperty(healthColumn);
    }
  });

  it('de-duplicates rows sharing a feed_url before insert, keeping the last occurrence', async () => {
    insertChain.returning.mockResolvedValueOnce([{ id: 'f1' }]);

    await repo.bulkUpsert([
      { category: 'new_funding', source_name: 'A (stale)', feed_url: 'https://dup/rss' },
      { category: 'new_funding', source_name: 'A (fresh)', feed_url: 'https://dup/rss' },
    ]);

    const values = insertChain.values.mock.calls[0][0];
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({ source_name: 'A (fresh)', feed_url: 'https://dup/rss' });
  });
});

describe('RssFeedRepository.update', () => {
  let repo: RssFeedRepository;

  beforeEach(() => {
    resetDb();
    repo = new RssFeedRepository(mockDb as never);
  });

  it('stamps updated_at alongside the caller-supplied fields', async () => {
    updateChain.returning.mockResolvedValueOnce([{ id: 'f1', status: 'paused' }]);

    const row = await repo.update('f1', { status: 'paused' });

    expect(row).toEqual({ id: 'f1', status: 'paused' });
    const setArg = updateChain.set.mock.calls[0][0];
    expect(setArg.status).toBe('paused');
    expect(setArg.updated_at).toBeDefined();
  });

  it('returns undefined when the id does not exist', async () => {
    updateChain.returning.mockResolvedValueOnce([]);
    expect(await repo.update('nope', { status: 'paused' })).toBeUndefined();
  });
});
