import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RecentFileRepository } from '@/lib/repositories';
import { RecentFileService, RECENT_FILES_PAGE_SIZE } from './recentFileService';

vi.mock('@/lib/s3', () => ({ getSignedUrl: vi.fn() }));

import { getSignedUrl } from '@/lib/s3';

afterEach(() => vi.clearAllMocks());

function makeRepoStub(): RecentFileRepository {
  return {
    recordOpen: vi.fn(),
    listByUser: vi.fn(),
    countByUser: vi.fn(),
  } as unknown as RecentFileRepository;
}

describe('RecentFileService.recordOpen', () => {
  it('delegates to the repository', async () => {
    const repo = makeRepoStub();
    const service = new RecentFileService(repo);

    await service.recordOpen('u1', 'deck.pptx', 'k1');

    expect(repo.recordOpen).toHaveBeenCalledWith('u1', 'deck.pptx', 'k1');
  });
});

describe('RecentFileService.listRecent', () => {
  it('maps rows and computes the offset from the page number', async () => {
    const repo = makeRepoStub();
    vi.mocked(repo.listByUser).mockResolvedValue([
      {
        id: 'r1',
        user_id: 'u1',
        file_name: 'a.pdf',
        file_key: 'k1',
        opened_at: '2026-06-23',
      },
    ] as never);
    vi.mocked(repo.countByUser).mockResolvedValue(25);
    const service = new RecentFileService(repo);

    const result = await service.listRecent('u1', 3);

    expect(repo.listByUser).toHaveBeenCalledWith('u1', {
      limit: RECENT_FILES_PAGE_SIZE,
      offset: 2 * RECENT_FILES_PAGE_SIZE,
    });
    expect(result).toEqual({
      items: [{ id: 'r1', file_name: 'a.pdf', file_key: 'k1', opened_at: '2026-06-23' }],
      total: 25,
      page: 3,
      pageSize: RECENT_FILES_PAGE_SIZE,
    });
  });

  it('clamps invalid page numbers to page 1 (offset 0)', async () => {
    const repo = makeRepoStub();
    vi.mocked(repo.listByUser).mockResolvedValue([] as never);
    vi.mocked(repo.countByUser).mockResolvedValue(0);
    const service = new RecentFileService(repo);

    const result = await service.listRecent('u1', 0);

    expect(repo.listByUser).toHaveBeenCalledWith('u1', {
      limit: RECENT_FILES_PAGE_SIZE,
      offset: 0,
    });
    expect(result.page).toBe(1);
  });
});

describe('RecentFileService.resolveSignedUrl', () => {
  it('signs the key inline (no file name, so the browser renders it)', async () => {
    const repo = makeRepoStub();
    vi.mocked(getSignedUrl).mockResolvedValue('https://signed.example/file');
    const service = new RecentFileService(repo);

    const url = await service.resolveSignedUrl('k1');

    expect(getSignedUrl).toHaveBeenCalledWith('k1', 3600);
    expect(url).toBe('https://signed.example/file');
  });
});

describe('RecentFileService.resolveDownloadUrl', () => {
  it('signs the key with the file name to force an attachment download', async () => {
    const repo = makeRepoStub();
    vi.mocked(getSignedUrl).mockResolvedValue('https://signed.example/download');
    const service = new RecentFileService(repo);

    const url = await service.resolveDownloadUrl('k1', 'a.pdf');

    expect(getSignedUrl).toHaveBeenCalledWith('k1', 3600, 'a.pdf');
    expect(url).toBe('https://signed.example/download');
  });
});
