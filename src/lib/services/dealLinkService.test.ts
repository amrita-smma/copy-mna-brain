import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DealDocumentRepository, DealLinkRepository, Tables } from '@/lib/repositories';
import { DealLinkService } from './dealLinkService';
import { UnsupportedFeaturedSlideError } from './featuredSlide';

afterEach(() => vi.clearAllMocks());

const YOUTUBE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

function makeRepoStub(): DealLinkRepository {
  return {
    findByDealId: vi.fn(),
    findById: vi.fn(),
    markFeatured: vi.fn(),
    clearFeaturedByDealId: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  } as unknown as DealLinkRepository;
}

// Featuring a link clears the document side too — the deal has one featured slide.
const docRepo = {
  clearFeaturedByDealId: vi.fn(),
} as unknown as DealDocumentRepository;

function makeLink(overrides: Partial<Tables<'deal_links'>> = {}): Tables<'deal_links'> {
  return {
    id: 'link-1',
    deal_id: 'company-1',
    url: YOUTUBE_URL,
    title: 'Founder pitch',
    stage: 'L1',
    created_at: new Date().toISOString(),
    is_featured: false,
    ...overrides,
  } as Tables<'deal_links'>;
}

describe('DealLinkService.create', () => {
  it('passes null for title when not provided', async () => {
    const repo = makeRepoStub();
    const service = new DealLinkService(repo, docRepo);

    await service.create('company-1', 'https://example.com');

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ title: null }),
    );
  });

  it('passes null for title when an empty string is given', async () => {
    const repo = makeRepoStub();
    const service = new DealLinkService(repo, docRepo);

    await service.create('company-1', 'https://example.com', '');

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ title: null }),
    );
  });

  it('passes the provided title when truthy', async () => {
    const repo = makeRepoStub();
    const service = new DealLinkService(repo, docRepo);

    await service.create('company-1', 'https://example.com', 'Annual Report');

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Annual Report' }),
    );
  });

  it('defaults stage to L0 when not provided', async () => {
    const repo = makeRepoStub();
    const service = new DealLinkService(repo, docRepo);

    await service.create('company-1', 'https://example.com');

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'L0' }),
    );
  });

  it('uses the provided stage when given', async () => {
    const repo = makeRepoStub();
    const service = new DealLinkService(repo, docRepo);

    await service.create('company-1', 'https://example.com', null, 'L2');

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'L2' }),
    );
  });

  it('passes the deal_id and url through', async () => {
    const repo = makeRepoStub();
    const service = new DealLinkService(repo, docRepo);

    await service.create('company-1', 'https://example.com');

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ deal_id: 'company-1', url: 'https://example.com' }),
    );
  });
});

describe('DealLinkService.create backdating', () => {
  it('leaves created_at off the insert when no date was supplied', async () => {
    const repo = makeRepoStub();
    const service = new DealLinkService(repo, docRepo);

    await service.create('company-1', 'https://example.com');

    expect(repo.insert).toHaveBeenCalledWith(
      expect.not.objectContaining({ created_at: expect.anything() }),
    );
  });

  it('stamps created_at when the composer backdated the entry', async () => {
    const repo = makeRepoStub();
    const service = new DealLinkService(repo, docRepo);

    await service.create('company-1', 'https://example.com', null, 'L1', '2026-10-09T14:30:00Z');

    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ created_at: '2026-10-09T14:30:00.000Z' }),
    );
  });

  it('rejects an unparseable date rather than silently stamping now', async () => {
    const repo = makeRepoStub();
    const service = new DealLinkService(repo, docRepo);

    await expect(service.create('company-1', 'https://example.com', null, 'L0', 'nope')).rejects.toThrow();
    expect(repo.insert).not.toHaveBeenCalled();
  });
});

describe('DealLinkService.create featured', () => {
  it('does not touch featured state for a plain link', async () => {
    const repo = makeRepoStub();
    const service = new DealLinkService(repo, docRepo);

    await service.create('company-1', YOUTUBE_URL);

    expect(repo.clearFeaturedByDealId).not.toHaveBeenCalled();
    expect(docRepo.clearFeaturedByDealId).not.toHaveBeenCalled();
    expect(repo.insert).toHaveBeenCalledWith(expect.not.objectContaining({ is_featured: true }));
  });

  it('clears the featured document and link before inserting a featured YouTube link', async () => {
    const repo = makeRepoStub();
    const callOrder: string[] = [];
    vi.mocked(docRepo.clearFeaturedByDealId).mockImplementation(async () => { callOrder.push('clear-doc'); });
    vi.mocked(repo.clearFeaturedByDealId).mockImplementation(async () => { callOrder.push('clear-link'); });
    vi.mocked(repo.insert).mockImplementation(async () => { callOrder.push('insert'); return makeLink(); });
    const service = new DealLinkService(repo, docRepo);

    await service.create('company-1', YOUTUBE_URL, 'Founder pitch', 'L1', null, true);

    expect(callOrder).toEqual(['clear-doc', 'clear-link', 'insert']);
    expect(repo.insert).toHaveBeenCalledWith(
      expect.objectContaining({ deal_id: 'company-1', url: YOUTUBE_URL, is_featured: true }),
    );
  });

  it('rejects featuring a link that is not a YouTube video, without clearing anything', async () => {
    const repo = makeRepoStub();
    const service = new DealLinkService(repo, docRepo);

    await expect(
      service.create('company-1', 'https://example.com/deck', null, 'L1', null, true),
    ).rejects.toThrow(UnsupportedFeaturedSlideError);
    expect(docRepo.clearFeaturedByDealId).not.toHaveBeenCalled();
    expect(repo.insert).not.toHaveBeenCalled();
  });
});

describe('DealLinkService.setFeatured', () => {
  it('clears both featured flags, then features the link', async () => {
    const repo = makeRepoStub();
    vi.mocked(repo.findById).mockResolvedValue(makeLink());
    const service = new DealLinkService(repo, docRepo);

    await service.setFeatured('company-1', 'link-1');

    expect(docRepo.clearFeaturedByDealId).toHaveBeenCalledWith('company-1');
    expect(repo.clearFeaturedByDealId).toHaveBeenCalledWith('company-1');
    expect(repo.markFeatured).toHaveBeenCalledWith('link-1');
  });

  it('rejects a link that belongs to a different deal', async () => {
    const repo = makeRepoStub();
    vi.mocked(repo.findById).mockResolvedValue(makeLink({ deal_id: 'company-2' }));
    const service = new DealLinkService(repo, docRepo);

    await expect(service.setFeatured('company-1', 'link-1')).rejects.toThrow(/does not belong/);
    expect(repo.markFeatured).not.toHaveBeenCalled();
  });

  it('rejects a link that is not a YouTube video', async () => {
    const repo = makeRepoStub();
    vi.mocked(repo.findById).mockResolvedValue(makeLink({ url: 'https://example.com' }));
    const service = new DealLinkService(repo, docRepo);

    await expect(service.setFeatured('company-1', 'link-1')).rejects.toThrow(UnsupportedFeaturedSlideError);
    expect(repo.clearFeaturedByDealId).not.toHaveBeenCalled();
    expect(repo.markFeatured).not.toHaveBeenCalled();
  });
});
