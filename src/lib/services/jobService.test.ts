import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient, JobRepository } from '@/lib/repositories';
import type { Tables } from '@/lib/repositories';
import { JobService } from './jobService';

type Job = Tables<'jobs'>;

const { markFailedIfPending } = vi.hoisted(() => ({
  markFailedIfPending: vi.fn(),
}));
const liveMocks = vi.hoisted(() => ({ publishLiveEvent: vi.fn() }));
vi.mock('@/lib/server/liveEvents', () => ({ publishLiveEvent: liveMocks.publishLiveEvent }));

// mirrorTerminalJobToSideRecord builds `new ScreeningRepository(db, workspaceId)`
// internally per stuck job — mock the repository class so we can assert on the
// shared markFailedIfPending mock without needing a real DbClient/query chain.
vi.mock('@/lib/repositories', async () => {
  const actual = await vi.importActual<typeof import('@/lib/repositories')>('@/lib/repositories');
  return {
    ...actual,
    ScreeningRepository: class {
      markFailedIfPending = markFailedIfPending;
    },
  };
});

function makeJob(overrides: Partial<Job>): Job {
  return {
    id: 'job-1',
    type: 'ai_screening',
    status: 'pending',
    payload: {},
    result: null,
    error: null,
    timeout_seconds: 240,
    workspace_id: 'workspace-1',
    created_at: new Date().toISOString(),
    started_at: null,
    completed_at: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Job;
}

function makeJobRepoStub(): JobRepository {
  return {
    findStuck: vi.fn(),
    markStuckAsTimedOut: vi.fn(),
    findByIdWithLogs: vi.fn(),
  } as unknown as JobRepository;
}

describe('JobService.cleanupStuckJobs', () => {
  let jobRepo: JobRepository;
  let service: JobService;

  beforeEach(() => {
    jobRepo = makeJobRepoStub();
    markFailedIfPending.mockReset();
    liveMocks.publishLiveEvent.mockReset().mockResolvedValue(undefined);
    service = new JobService(jobRepo, {} as unknown as DbClient);
  });

  it('announces each timed-out job on the jobs topic after the write, skipping jobs without a workspace', async () => {
    vi.mocked(jobRepo.findStuck).mockResolvedValue([
      makeJob({ id: 'ws-job', status: 'running', type: 'graph_sync' as Job['type'] }),
      makeJob({ id: 'global-job', status: 'running', type: 'graph_sync' as Job['type'], workspace_id: null }),
    ]);
    vi.mocked(jobRepo.markStuckAsTimedOut).mockImplementation(async (id) => makeJob({ id, status: 'timed_out' }));

    await service.cleanupStuckJobs();

    expect(liveMocks.publishLiveEvent).toHaveBeenCalledTimes(1);
    expect(liveMocks.publishLiveEvent).toHaveBeenCalledWith('workspace-1', 'jobs', ['ws-job']);
    expect(liveMocks.publishLiveEvent.mock.invocationCallOrder[0]).toBeGreaterThan(
      vi.mocked(jobRepo.markStuckAsTimedOut).mock.invocationCallOrder[0],
    );
  });

  it('returns zero when nothing is stuck', async () => {
    vi.mocked(jobRepo.findStuck).mockResolvedValue([]);

    const result = await service.cleanupStuckJobs();

    expect(result).toEqual({ cleaned: 0, failed: 0, jobIds: [] });
    expect(jobRepo.markStuckAsTimedOut).not.toHaveBeenCalled();
    expect(markFailedIfPending).not.toHaveBeenCalled();
  });

  it('marks stuck pending and running jobs as timed out', async () => {
    const stuck = [
      makeJob({ id: 'pending-1', status: 'pending', timeout_seconds: 240 }),
      makeJob({ id: 'running-1', status: 'running', timeout_seconds: 120 }),
    ];
    vi.mocked(jobRepo.findStuck).mockResolvedValue(stuck);
    vi.mocked(jobRepo.markStuckAsTimedOut).mockImplementation(async (id) =>
      makeJob({ id, status: 'timed_out' }),
    );

    const result = await service.cleanupStuckJobs();

    expect(result.cleaned).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.jobIds).toEqual(['pending-1', 'running-1']);

    expect(jobRepo.markStuckAsTimedOut).toHaveBeenCalledTimes(2);
    const [pendingCall, runningCall] = vi.mocked(jobRepo.markStuckAsTimedOut).mock.calls;
    expect(pendingCall[0]).toBe('pending-1');
    expect(pendingCall[1]).toMatch(/pending/);
    expect(runningCall[0]).toBe('running-1');
    expect(runningCall[1]).toMatch(/running/);
  });

  it('continues when one cleanup write fails and reports the failure count', async () => {
    const stuck = [
      makeJob({ id: 'a', status: 'pending' }),
      makeJob({ id: 'b', status: 'pending' }),
      makeJob({ id: 'c', status: 'pending' }),
    ];
    vi.mocked(jobRepo.findStuck).mockResolvedValue(stuck);
    vi.mocked(jobRepo.markStuckAsTimedOut).mockImplementation(async (id) => {
      if (id === 'b') throw new Error('write failure');
      return makeJob({ id, status: 'timed_out' });
    });

    // Silence the expected console.error for the failing job.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await service.cleanupStuckJobs();

    expect(result.cleaned).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.jobIds).toEqual(['a', 'c']);
    expect(jobRepo.markStuckAsTimedOut).toHaveBeenCalledTimes(3);

    errSpy.mockRestore();
  });

  it('forwards the configured buffer to the repository', async () => {
    vi.mocked(jobRepo.findStuck).mockResolvedValue([]);
    await service.cleanupStuckJobs(15);
    expect(jobRepo.findStuck).toHaveBeenCalledWith(15);
  });

  it('mirrors a stuck ai_screening job onto its screening via payload.screeningId', async () => {
    const stuck = [
      makeJob({
        id: 'job-x',
        type: 'ai_screening',
        status: 'running',
        payload: { screeningId: 'screening-x' },
      }),
    ];
    vi.mocked(jobRepo.findStuck).mockResolvedValue(stuck);
    vi.mocked(jobRepo.markStuckAsTimedOut).mockImplementation(async (id) =>
      makeJob({ id, status: 'timed_out' }),
    );

    await service.cleanupStuckJobs();

    expect(markFailedIfPending).toHaveBeenCalledTimes(1);
    const [screeningId, remarks] = markFailedIfPending.mock.calls[0];
    expect(screeningId).toBe('screening-x');
    expect(remarks).toContain('job-x');
    expect(remarks).toMatch(/timed out/i);
  });

  it('skips the mirror for non-ai_screening job types', async () => {
    const stuck = [
      makeJob({
        id: 'cleanup-1',
        type: 'stuck_cleanup',
        status: 'running',
        payload: { screeningId: 'should-be-ignored' },
      }),
    ];
    vi.mocked(jobRepo.findStuck).mockResolvedValue(stuck);
    vi.mocked(jobRepo.markStuckAsTimedOut).mockImplementation(async (id) =>
      makeJob({ id, status: 'timed_out' }),
    );

    await service.cleanupStuckJobs();

    expect(markFailedIfPending).not.toHaveBeenCalled();
  });

  it('skips the mirror when payload has no screeningId', async () => {
    const stuck = [
      makeJob({
        id: 'job-y',
        type: 'ai_screening',
        status: 'running',
        payload: {},
      }),
    ];
    vi.mocked(jobRepo.findStuck).mockResolvedValue(stuck);
    vi.mocked(jobRepo.markStuckAsTimedOut).mockImplementation(async (id) =>
      makeJob({ id, status: 'timed_out' }),
    );

    await service.cleanupStuckJobs();

    expect(markFailedIfPending).not.toHaveBeenCalled();
  });

  it('still counts the job as cleaned even if the screening mirror itself throws', async () => {
    const stuck = [
      makeJob({
        id: 'job-z',
        type: 'ai_screening',
        status: 'running',
        payload: { screeningId: 'screening-z' },
      }),
    ];
    vi.mocked(jobRepo.findStuck).mockResolvedValue(stuck);
    vi.mocked(jobRepo.markStuckAsTimedOut).mockImplementation(async (id) =>
      makeJob({ id, status: 'timed_out' }),
    );
    markFailedIfPending.mockRejectedValue(new Error('mirror failed'));

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await service.cleanupStuckJobs();

    expect(result.cleaned).toBe(1);
    expect(result.failed).toBe(0);

    errSpy.mockRestore();
  });
});
