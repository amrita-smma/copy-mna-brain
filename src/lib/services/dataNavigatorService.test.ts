import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DataNavigatorService, RssItemNotFoundError } from './dataNavigatorService';
import { MAX_PAGE_SIZE } from '@/lib/repositories';
import type { RssItemRepository, RssItemChunkRepository } from '@/lib/repositories';
import type { BedrockEmbeddingClient } from '@/lib/bedrock';

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    category: 'new_funding',
    source_name: 'Mint',
    region: 'India',
    feed_tier: 'curated',
    title: `Title ${id}`,
    link: `https://example.com/${id}`,
    summary: `Summary ${id}`,
    authors: null,
    tags: null,
    published_at: '2026-09-02T08:00:00.000Z',
    ingested_at: '2026-09-02T08:05:00.000Z',
    relevance: 'selected',
    relevance_score: 0.9,
    content_status: 'fetched',
    ...overrides,
  };
}

describe('DataNavigatorService', () => {
  let itemRepo: {
    listItems: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findByIds: ReturnType<typeof vi.fn>;
    textSearch: ReturnType<typeof vi.fn>;
    listFilterOptions: ReturnType<typeof vi.fn>;
  };
  let chunkRepo: { vectorSearch: ReturnType<typeof vi.fn> };
  let embeddings: { embed: ReturnType<typeof vi.fn> };
  let service: DataNavigatorService;

  beforeEach(() => {
    itemRepo = {
      listItems: vi.fn(),
      findById: vi.fn(),
      findByIds: vi.fn(),
      textSearch: vi.fn().mockResolvedValue([]),
      listFilterOptions: vi.fn(),
    };
    chunkRepo = { vectorSearch: vi.fn().mockResolvedValue([]) };
    embeddings = { embed: vi.fn().mockResolvedValue(Array.from({ length: 1024 }, () => 0.01)) };
    service = new DataNavigatorService(
      itemRepo as unknown as RssItemRepository,
      chunkRepo as unknown as RssItemChunkRepository,
      embeddings as unknown as BedrockEmbeddingClient,
    );
  });

  it('listItems returns a null cursor when the page is not full', async () => {
    itemRepo.listItems.mockResolvedValueOnce([row('a')]);

    const out = await service.listItems({ limit: 50 });

    expect(out.items).toHaveLength(1);
    expect(out.nextCursor).toBeNull();
  });

  it('listItems returns a cursor built from the last row when the page is full', async () => {
    itemRepo.listItems.mockResolvedValueOnce([row('a'), row('b')]);

    const out = await service.listItems({ limit: 2 });

    expect(out.nextCursor).toEqual({ publishedAt: '2026-09-02T08:00:00.000Z', id: 'b' });
  });

  it('listItems builds a cursor from the last row when a page-full of the EFFECTIVE (clamped) limit comes back, even if the requested limit was above the cap', async () => {
    const rows = Array.from({ length: MAX_PAGE_SIZE }, (_, i) =>
      row(`id-${i}`, { published_at: `2026-09-02T08:00:0${i % 10}.000Z` }),
    );
    itemRepo.listItems.mockResolvedValueOnce(rows);

    const out = await service.listItems({ limit: 1000 });

    const last = rows[rows.length - 1];
    expect(out.nextCursor).toEqual({ publishedAt: last.published_at, id: last.id });
  });

  it('getItem throws RssItemNotFoundError for an unknown id', async () => {
    itemRepo.findById.mockResolvedValueOnce(undefined);
    await expect(service.getItem('nope')).rejects.toBeInstanceOf(RssItemNotFoundError);
  });

  it('getItem returns the full row including content_text', async () => {
    itemRepo.findById.mockResolvedValueOnce({ ...row('a'), content_text: 'Body' });
    const item = await service.getItem('a');
    expect(item.content_text).toBe('Body');
  });

  it('searchNews embeds the query once and runs both search halves', async () => {
    chunkRepo.vectorSearch.mockResolvedValueOnce([
      { item_id: 'a', chunk_text: 'Acme raised money', distance: 0.2 },
    ]);
    itemRepo.findByIds.mockResolvedValueOnce([row('a')]);

    const hits = await service.searchNews('acme funding');

    expect(embeddings.embed).toHaveBeenCalledTimes(1);
    expect(itemRepo.textSearch).toHaveBeenCalledTimes(1);
    expect(hits).toHaveLength(1);
    expect(hits[0].matchedBy).toBe('vector');
    expect(hits[0].snippet).toBe('Acme raised money');
  });

  it('searchNews marks an item found by both halves and ranks it first', async () => {
    chunkRepo.vectorSearch.mockResolvedValueOnce([
      { item_id: 'a', chunk_text: 'chunk a', distance: 0.4 },
      { item_id: 'b', chunk_text: 'chunk b', distance: 0.3 },
    ]);
    itemRepo.textSearch.mockResolvedValueOnce([row('a')]);
    itemRepo.findByIds.mockResolvedValueOnce([row('a'), row('b')]);

    const hits = await service.searchNews('acme');

    expect(hits[0].id).toBe('a');
    expect(hits[0].matchedBy).toBe('both');
    expect(hits[1].matchedBy).toBe('vector');
  });

  it('searchNews still returns lexical hits when embedding fails', async () => {
    embeddings.embed.mockRejectedValueOnce(new Error('bedrock down'));
    itemRepo.textSearch.mockResolvedValueOnce([row('a')]);
    itemRepo.findByIds.mockResolvedValueOnce([row('a')]);

    const hits = await service.searchNews('acme');

    expect(hits).toHaveLength(1);
    expect(hits[0].matchedBy).toBe('text');
    expect(chunkRepo.vectorSearch).not.toHaveBeenCalled();
  });

  it('searchNews still returns vector hits when the lexical half rejects', async () => {
    itemRepo.textSearch.mockReset();
    itemRepo.textSearch.mockRejectedValueOnce(new Error('connection pool exhausted'));
    chunkRepo.vectorSearch.mockResolvedValueOnce([
      { item_id: 'a', chunk_text: 'Acme raised money', distance: 0.2 },
    ]);
    itemRepo.findByIds.mockResolvedValueOnce([row('a')]);

    const hits = await service.searchNews('acme');

    expect(hits).toHaveLength(1);
    expect(hits[0].matchedBy).toBe('vector');
  });

  it('searchNews returns [] when both halves fail, without throwing', async () => {
    itemRepo.textSearch.mockReset();
    itemRepo.textSearch.mockRejectedValueOnce(new Error('connection pool exhausted'));
    embeddings.embed.mockRejectedValueOnce(new Error('bedrock down'));

    const hits = await service.searchNews('acme');

    expect(hits).toEqual([]);
  });

  it('searchNews returns [] for a blank query without calling anything', async () => {
    expect(await service.searchNews('   ')).toEqual([]);
    expect(embeddings.embed).not.toHaveBeenCalled();
    expect(itemRepo.textSearch).not.toHaveBeenCalled();
  });

  it('searchNews hydrates every hit in one batched call, never per hit', async () => {
    chunkRepo.vectorSearch.mockResolvedValueOnce([
      { item_id: 'a', chunk_text: 'x', distance: 0.1 },
      { item_id: 'b', chunk_text: 'y', distance: 0.2 },
      { item_id: 'c', chunk_text: 'z', distance: 0.3 },
    ]);
    itemRepo.findByIds.mockResolvedValueOnce([row('a'), row('b'), row('c')]);

    await service.searchNews('acme');

    expect(itemRepo.findByIds).toHaveBeenCalledTimes(1);
    expect(itemRepo.findByIds).toHaveBeenCalledWith(expect.arrayContaining(['a', 'b', 'c']));
  });

  it('searchNews drops hits whose item row has since disappeared', async () => {
    chunkRepo.vectorSearch.mockResolvedValueOnce([
      { item_id: 'a', chunk_text: 'x', distance: 0.1 },
      { item_id: 'gone', chunk_text: 'y', distance: 0.2 },
    ]);
    itemRepo.findByIds.mockResolvedValueOnce([row('a')]);

    const hits = await service.searchNews('acme');

    expect(hits.map((h) => h.id)).toEqual(['a']);
  });

  it('searchNews honours topK after merging both halves', async () => {
    chunkRepo.vectorSearch.mockResolvedValueOnce([
      { item_id: 'a', chunk_text: 'x', distance: 0.1 },
      { item_id: 'b', chunk_text: 'y', distance: 0.2 },
    ]);
    itemRepo.findByIds.mockResolvedValueOnce([row('a'), row('b')]);

    const hits = await service.searchNews('acme', { topK: 1 });

    expect(hits).toHaveLength(1);
  });

  it("searchNews carries through the hydrated row's real relevance instead of assuming curated", async () => {
    chunkRepo.vectorSearch.mockResolvedValueOnce([
      { item_id: 'a', chunk_text: 'x', distance: 0.1 },
    ]);
    // Note: not 'selected' — a hit can surface for a pending/rejected item
    // too, since search has no relevance filter unless selectedOnly is set.
    itemRepo.findByIds.mockResolvedValueOnce([row('a', { relevance: 'pending' })]);

    const hits = await service.searchNews('acme');

    expect(hits[0].relevance).toBe('pending');
  });

  it('searchNews forwards selectedOnly to both the vector and lexical halves', async () => {
    chunkRepo.vectorSearch.mockResolvedValueOnce([]);
    itemRepo.textSearch.mockResolvedValueOnce([]);

    await service.searchNews('acme', { selectedOnly: true });

    expect(chunkRepo.vectorSearch).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ selectedOnly: true }),
    );
    expect(itemRepo.textSearch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ selectedOnly: true }),
      expect.anything(),
    );
  });

  it('listFilterOptions groups sources under their category and dedupes regions', async () => {
    itemRepo.listFilterOptions.mockResolvedValueOnce([
      { category: 'new_funding', source_name: 'Mint', region: 'India' },
      { category: 'new_funding', source_name: 'DealStreetAsia', region: 'APAC' },
      { category: 'ma_partnerships', source_name: 'MarketBeat', region: 'India' },
    ]);

    const options = await service.listFilterOptions();

    expect(options.categories).toEqual(['ma_partnerships', 'new_funding']);
    expect(options.regions).toEqual(['APAC', 'India']);
    expect(options.sources).toHaveLength(3);
  });
});
