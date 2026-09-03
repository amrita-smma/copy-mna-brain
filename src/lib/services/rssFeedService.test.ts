import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RssFeedService, RssFeedNotFoundError } from './rssFeedService';
import type { RssFeedRepository } from '@/lib/repositories';

describe('RssFeedService', () => {
  let repo: {
    list: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    insert: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    bulkUpsert: ReturnType<typeof vi.fn>;
  };
  let service: RssFeedService;

  beforeEach(() => {
    repo = {
      list: vi.fn(),
      findById: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      bulkUpsert: vi.fn(),
    };
    service = new RssFeedService(repo as unknown as RssFeedRepository);
  });

  it('listFeeds delegates to repo.list', async () => {
    repo.list.mockResolvedValueOnce([{ id: 'f1' }]);
    expect(await service.listFeeds({ statuses: ['active'] })).toEqual([{ id: 'f1' }]);
    expect(repo.list).toHaveBeenCalledWith({ statuses: ['active'] });
  });

  it('updateFeed throws RssFeedNotFoundError when the row is missing', async () => {
    repo.update.mockResolvedValueOnce(undefined);
    await expect(service.updateFeed('missing', { status: 'paused' })).rejects.toBeInstanceOf(
      RssFeedNotFoundError,
    );
  });

  it('deleteFeed refuses to delete a feed that does not exist', async () => {
    repo.findById.mockResolvedValueOnce(undefined);
    await expect(service.deleteFeed('missing')).rejects.toBeInstanceOf(RssFeedNotFoundError);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('importFeeds upserts valid rows and reports invalid ones without aborting', async () => {
    repo.bulkUpsert.mockResolvedValueOnce(1);

    const result = await service.importFeeds([
      { category: 'new_funding', source_name: 'Mint', feed_url: 'https://mint/rss' },
      { category: 'not_a_category', source_name: 'X', feed_url: 'https://x/rss' },
      { category: 'new_funding', source_name: 'Y' },
    ]);

    expect(result.imported).toBe(1);
    expect(result.skipped).toEqual([
      { index: 1, reason: 'unknown category "not_a_category"' },
      { index: 2, reason: 'feed_url is required' },
    ]);
    expect(repo.bulkUpsert).toHaveBeenCalledWith([
      {
        category: 'new_funding',
        source_name: 'Mint',
        feed_url: 'https://mint/rss',
        region: null,
        tier: 'curated',
        status: 'active',
        notes: null,
      },
    ]);
  });

  it('importFeeds defaults tier to query for Google/Bing News URLs', async () => {
    repo.bulkUpsert.mockResolvedValueOnce(1);

    await service.importFeeds([
      {
        category: 'ma_partnerships',
        source_name: 'Google News: M&A',
        feed_url: 'https://news.google.com/rss/search?q=acquisition',
      },
    ]);

    expect(repo.bulkUpsert.mock.calls[0][0][0].tier).toBe('query');
  });

  it('importFeeds honours an explicit tier over the URL heuristic', async () => {
    repo.bulkUpsert.mockResolvedValueOnce(1);

    await service.importFeeds([
      {
        category: 'ma_partnerships',
        source_name: 'Google News: M&A',
        feed_url: 'https://news.google.com/rss/search?q=acquisition',
        tier: 'curated',
      },
    ]);

    expect(repo.bulkUpsert.mock.calls[0][0][0].tier).toBe('curated');
  });

  it('importFeeds does not call the repository when every row is invalid', async () => {
    const result = await service.importFeeds([{ nonsense: true }]);
    expect(result.imported).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(repo.bulkUpsert).not.toHaveBeenCalled();
  });
});
