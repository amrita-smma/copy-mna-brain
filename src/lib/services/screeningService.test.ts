import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreeningRepository } from '@/lib/repositories';
import { ScreeningService } from './screeningService';

function makeRepoStub(): ScreeningRepository {
  return {
    findAllWithRelations: vi.fn().mockResolvedValue([]),
    insert: vi.fn(),
    update: vi.fn(),
    markFailedIfPending: vi.fn(),
    upsertOrReset: vi.fn().mockResolvedValue([]),
  } as unknown as ScreeningRepository;
}

describe('ScreeningService.prepare', () => {
  let repo: ScreeningRepository;
  let service: ScreeningService;

  beforeEach(() => {
    repo = makeRepoStub();
    service = new ScreeningService(repo);
  });

  it('delegates per-track groups to the repository upsertOrReset', async () => {
    const groups = [
      { companyId: 'co-1', trackId: 't-1', criteriaIds: ['c1', 'c2'] },
      { companyId: 'co-1', trackId: 't-2', criteriaIds: ['c3'] },
    ];

    await service.prepare(groups);

    expect(repo.upsertOrReset).toHaveBeenCalledWith(groups);
  });

  it('passes an empty group list straight through', async () => {
    await service.prepare([]);
    expect(repo.upsertOrReset).toHaveBeenCalledWith([]);
  });
});

describe('ScreeningService.findAll', () => {
  it('delegates to the repository with the given options', async () => {
    const repo = makeRepoStub();
    const service = new ScreeningService(repo);

    await service.findAll({ onlyL0: true });

    expect(repo.findAllWithRelations).toHaveBeenCalledWith({ onlyL0: true });
  });
});
