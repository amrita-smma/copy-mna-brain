import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreeningRepository } from '@/lib/repositories';

const posthogMocks = vi.hoisted(() => ({ captureWorkspaceEvent: vi.fn() }));
vi.mock('@/lib/posthog-server', () => ({
  captureWorkspaceEvent: posthogMocks.captureWorkspaceEvent,
}));

import { ScreeningService } from './screeningService';

const WORKSPACE_ID = 'ws-test';

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
    posthogMocks.captureWorkspaceEvent.mockReset();
    repo = makeRepoStub();
    service = new ScreeningService(repo, WORKSPACE_ID);
  });

  it('delegates per-track groups to the repository upsertOrReset', async () => {
    const groups = [
      { companyId: 'co-1', trackId: 't-1', criteriaIds: ['c1', 'c2'] },
      { companyId: 'co-1', trackId: 't-2', criteriaIds: ['c3'] },
    ];

    await service.prepare(groups);

    expect(repo.upsertOrReset).toHaveBeenCalledWith(groups);
  });

  it('returns the rows the repository produced', async () => {
    const rows = [{ id: 's-1' }, { id: 's-2' }];
    vi.mocked(repo.upsertOrReset).mockResolvedValue(rows as never);

    await expect(service.prepare([])).resolves.toBe(rows);
  });

  it('passes an empty group list straight through', async () => {
    await service.prepare([]);
    expect(repo.upsertOrReset).toHaveBeenCalledWith([]);
  });

  it('captures ai_screening_started against the acting user', async () => {
    vi.mocked(repo.upsertOrReset).mockResolvedValue([
      { id: 's-1' },
      { id: 's-2' },
      { id: 's-3' },
    ] as never);

    await service.prepare(
      [
        { companyId: 'co-1', trackId: 't-1', criteriaIds: ['c1', 'c2'] },
        { companyId: 'co-1', trackId: 't-2', criteriaIds: ['c3'] },
      ],
      'user-7',
    );

    expect(posthogMocks.captureWorkspaceEvent).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      distinctId: 'user-7',
      event: 'ai_screening_started',
      properties: { company_count: 1, track_count: 2, total_screenings: 3 },
    });
  });

  it('counts distinct companies, not groups', async () => {
    await service.prepare([
      { companyId: 'co-1', trackId: 't-1', criteriaIds: ['c1'] },
      { companyId: 'co-2', trackId: 't-1', criteriaIds: ['c1'] },
      { companyId: 'co-2', trackId: 't-2', criteriaIds: ['c1'] },
    ]);

    expect(posthogMocks.captureWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({ company_count: 2, track_count: 3 }),
      }),
    );
  });

  it("falls back to 'server' when no user is supplied", async () => {
    await service.prepare([]);

    expect(posthogMocks.captureWorkspaceEvent).toHaveBeenCalledWith(
      expect.objectContaining({ distinctId: 'server' }),
    );
  });

  it('does not capture a started run when the upsert fails', async () => {
    vi.mocked(repo.upsertOrReset).mockRejectedValue(new Error('db down'));

    await expect(service.prepare([])).rejects.toThrow('db down');
    expect(posthogMocks.captureWorkspaceEvent).not.toHaveBeenCalled();
  });
});

describe('ScreeningService.findAll', () => {
  it('delegates to the repository with the given options', async () => {
    const repo = makeRepoStub();
    const service = new ScreeningService(repo, WORKSPACE_ID);

    await service.findAll({ inScreening: true });

    expect(repo.findAllWithRelations).toHaveBeenCalledWith({ inScreening: true });
  });
});
