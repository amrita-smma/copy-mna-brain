import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobRepository, ScreeningRepository } from '@/lib/repositories';
import type { Tables } from '@/lib/repositories';
import { JobService } from './jobService';

type Job = Tables<'jobs'>;

function makeJob(overrides: Partial<Job>): Job {
  return {
    id: 'job-1',
    type: 'ai_screening',
    status: 'pending',
    payload: {},
    result: null,
    error: null,
    timeout_seconds: 240,
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

function makeScreeningRepoStub(): ScreeningRepository {
  return {
    markFailedIfPending: vi.fn(),
  } as unknown as ScreeningRepository;
}

describe('JobService.cleanupStuckJobs', () => {
  let jobRepo: JobRepository;
  let screeningRepo: ScreeningRepository;
  let service: JobService;

  beforeEach(() => {
    jobRepo = makeJobRepoStub();
    screeningRepo = makeScreeningRepoStub();
    service = new JobService(jobRepo, screeningRepo);
  });

  it('returns zero when nothing is stuck', async () => {
    vi.mocked(jobRepo.findStuck).mockResolvedValue([]);

    const result = await service.cleanupStuckJobs();

    expect(result).toEqual({ cleaned: 0, failed: 0, jobIds: [] });
    expect(jobRepo.markStuckAsTimedOut).not.toHaveBeenCalled();
    expect(screeningRepo.markFailedIfPending).not.toHaveBeenCalled();
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

    expect(screeningRepo.markFailedIfPending).toHaveBeenCalledTimes(1);
    const [screeningId, remarks] = vi.mocked(screeningRepo.markFailedIfPending).mock.calls[0];
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

    expect(screeningRepo.markFailedIfPending).not.toHaveBeenCalled();
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

    expect(screeningRepo.markFailedIfPending).not.toHaveBeenCalled();
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
    vi.mocked(screeningRepo.markFailedIfPending).mockRejectedValue(new Error('mirror failed'));

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await service.cleanupStuckJobs();

    expect(result.cleaned).toBe(1);
    expect(result.failed).toBe(0);

    errSpy.mockRestore();
  });
});
