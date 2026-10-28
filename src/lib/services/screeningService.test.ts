import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreeningRepository } from '@/lib/repositories';

const posthogMocks = vi.hoisted(() => ({ captureWorkspaceEvent: vi.fn() }));
vi.mock('@/lib/posthog-server', () => ({
  captureWorkspaceEvent: posthogMocks.captureWorkspaceEvent,
}));
const liveMocks = vi.hoisted(() => ({ publishLiveEvent: vi.fn(async () => undefined) }));
vi.mock('@/lib/server/liveEvents', () => ({ publishLiveEvent: liveMocks.publishLiveEvent }));

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
    liveMocks.publishLiveEvent.mockClear();
    repo = makeRepoStub();
    service = new ScreeningService(repo, WORKSPACE_ID);
  });

  it('publishes the prepared rows on the screenings live topic after the upsert', async () => {
    (repo.upsertOrReset as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: 's-1' }, { id: 's-2' }]);

    await service.prepare([{ companyId: 'co-1', trackId: 't-1', criteriaIds: ['c1'] }]);

    expect(liveMocks.publishLiveEvent).toHaveBeenCalledWith(WORKSPACE_ID, 'screenings', ['s-1', 's-2']);
  });

  it('does not publish when the upsert fails', async () => {
    (repo.upsertOrReset as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('db down'));

    await expect(service.prepare([{ companyId: 'co-1', trackId: 't-1', criteriaIds: ['c1'] }])).rejects.toThrow('db down');

    expect(liveMocks.publishLiveEvent).not.toHaveBeenCalled();
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

describe('ScreeningService.create / update', () => {
  it('publish the written row on the screenings live topic', async () => {
    liveMocks.publishLiveEvent.mockClear();
    const repo = makeRepoStub();
    (repo.insert as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 's-new' });
    (repo.update as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 's-1', state: 'completed' });
    const service = new ScreeningService(repo, WORKSPACE_ID);

    await expect(service.create({ company_id: 'co-1' } as never)).resolves.toEqual({ id: 's-new' });
    await expect(service.update('s-1', { state: 'completed' })).resolves.toEqual({ id: 's-1', state: 'completed' });

    expect(liveMocks.publishLiveEvent.mock.calls).toEqual([
      [WORKSPACE_ID, 'screenings', ['s-new']],
      [WORKSPACE_ID, 'screenings', ['s-1']],
    ]);
  });
});
