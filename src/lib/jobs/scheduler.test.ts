import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tables } from '@/lib/repositories';

type Job = Tables<'jobs'>;

const findMostRecentByType = vi.fn();
const create = vi.fn();
const markRunning = vi.fn();
const markCompleted = vi.fn();
const markFailed = vi.fn();
const markTimedOut = vi.fn();
const findStuck = vi.fn();
const markStuckAsTimedOut = vi.fn();
const cleanupStuckJobs = vi.fn();

vi.mock('@/lib/repositories', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/repositories')>();
  class MockJobRepository {
    findMostRecentByType = findMostRecentByType;
    create = create;
    markRunning = markRunning;
    markCompleted = markCompleted;
    markFailed = markFailed;
    markTimedOut = markTimedOut;
    findStuck = findStuck;
    markStuckAsTimedOut = markStuckAsTimedOut;
  }
  return { ...actual, JobRepository: MockJobRepository };
});

vi.mock('@/lib/services/jobService', () => {
  class MockJobService {
    cleanupStuckJobs = cleanupStuckJobs;
  }
  return { JobService: MockJobService };
});

import { runSchedulerIfDue, __resetSchedulerForTests } from './scheduler';

function makeJob(overrides: Partial<Job>): Job {
  return {
    id: overrides.id ?? 'scheduler-job-1',
    type: overrides.type ?? 'stuck_cleanup',
    status: overrides.status ?? 'pending',
    payload: overrides.payload ?? {},
    result: overrides.result ?? null,
    error: overrides.error ?? null,
    timeout_seconds: overrides.timeout_seconds ?? 300,
    created_at: overrides.created_at ?? new Date().toISOString(),
    started_at: overrides.started_at ?? null,
    completed_at: overrides.completed_at ?? null,
    updated_at: overrides.updated_at ?? new Date().toISOString(),
  } as Job;
}

const fakeDb = {} as never;

describe('runSchedulerIfDue', () => {
  beforeEach(() => {
    __resetSchedulerForTests();
    findMostRecentByType.mockReset();
    create.mockReset();
    markRunning.mockReset();
    markCompleted.mockReset();
    markFailed.mockReset();
    markTimedOut.mockReset();
    findStuck.mockReset();
    markStuckAsTimedOut.mockReset();
    cleanupStuckJobs.mockReset();

    markRunning.mockImplementation(async (id: string) => makeJob({ id, status: 'running' }));
    markCompleted.mockImplementation(async (id: string) => makeJob({ id, status: 'completed' }));
    cleanupStuckJobs.mockResolvedValue({ cleaned: 0, failed: 0, jobIds: [] });
  });

  afterEach(() => {
    __resetSchedulerForTests();
  });

  it('dispatches and runs a sweep when no recent stuck_cleanup exists', async () => {
    findMostRecentByType.mockResolvedValue(null);
    create.mockImplementation(async (input) => makeJob({ id: 'new-sweep', ...input }));

    const ran = await runSchedulerIfDue(fakeDb);

    expect(ran).toBe(true);
    expect(findMostRecentByType).toHaveBeenCalledWith('stuck_cleanup', expect.any(String));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ type: 'stuck_cleanup' }));
    expect(markRunning).toHaveBeenCalledWith('new-sweep');
    expect(cleanupStuckJobs).toHaveBeenCalledOnce();
    expect(markCompleted).toHaveBeenCalledWith('new-sweep', expect.anything());
  });

  it('skips when a stuck_cleanup ran within the window', async () => {
    findMostRecentByType.mockResolvedValue(makeJob({ id: 'recent' }));

    const ran = await runSchedulerIfDue(fakeDb);

    expect(ran).toBe(false);
    expect(create).not.toHaveBeenCalled();
    expect(markRunning).not.toHaveBeenCalled();
    expect(cleanupStuckJobs).not.toHaveBeenCalled();
  });

  it('uses the passed-in window when computing the cutoff', async () => {
    findMostRecentByType.mockResolvedValue(null);
    create.mockImplementation(async (input) => makeJob({ id: 'n', ...input }));
    const fixedNow = new Date('2026-04-24T12:00:00Z').getTime();

    await runSchedulerIfDue(fakeDb, { windowSeconds: 3600, now: () => fixedNow });

    const [, cutoff] = findMostRecentByType.mock.calls[0];
    expect(new Date(cutoff).getTime()).toBe(fixedNow - 3600 * 1000);
  });

  it('coalesces concurrent callers via the in-flight guard', async () => {
    findMostRecentByType.mockResolvedValue(null);
    let resolveCreate: (job: Job) => void = () => {};
    create.mockImplementation(
      () =>
        new Promise<Job>((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const first = runSchedulerIfDue(fakeDb);
    const second = runSchedulerIfDue(fakeDb);

    // Flush the microtask queue so findMostRecentByType + create promises resolve.
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));

    resolveCreate(makeJob({ id: 'shared' }));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(markRunning).toHaveBeenCalledTimes(1);
  });

  it('releases the in-flight guard after completion so later calls can run', async () => {
    findMostRecentByType.mockResolvedValueOnce(null);
    create.mockImplementationOnce(async (input) => makeJob({ id: 'first', ...input }));
    await runSchedulerIfDue(fakeDb);

    findMostRecentByType.mockResolvedValueOnce(makeJob({ id: 'first' }));
    const ran = await runSchedulerIfDue(fakeDb);
    expect(ran).toBe(false);
  });

  describe('on Vercel preview deployments', () => {
    const originalVercelEnv = process.env.VERCEL_ENV;

    afterEach(() => {
      if (originalVercelEnv === undefined) {
        delete process.env.VERCEL_ENV;
      } else {
        process.env.VERCEL_ENV = originalVercelEnv;
      }
    });

    it('skips without touching the database when VERCEL_ENV is preview', async () => {
      process.env.VERCEL_ENV = 'preview';

      const ran = await runSchedulerIfDue(fakeDb);

      expect(ran).toBe(false);
      expect(findMostRecentByType).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });

    it.each(['production', undefined])('still runs when VERCEL_ENV is %s', async (value) => {
      if (value === undefined) {
        delete process.env.VERCEL_ENV;
      } else {
        process.env.VERCEL_ENV = value;
      }
      findMostRecentByType.mockResolvedValue(null);
      create.mockImplementation(async (input) => makeJob({ id: 'non-preview', ...input }));

      const ran = await runSchedulerIfDue(fakeDb);

      expect(ran).toBe(true);
      expect(findMostRecentByType).toHaveBeenCalledWith('stuck_cleanup', expect.any(String));
    });
  });
});
