import { beforeEach, describe, expect, it, vi } from 'vitest';

const live = vi.hoisted(() => ({ publishLiveEvent: vi.fn() }));
vi.mock('@/lib/server/liveEvents', () => ({ publishLiveEvent: live.publishLiveEvent }));
vi.mock('@/lib/langfuse', () => ({ flushLangfuse: vi.fn() }));

import type { JobRepository, Tables } from '@/lib/repositories';
import { runJob } from './runner';

function makeJob(overrides: Partial<Tables<'jobs'>> = {}): Tables<'jobs'> {
  return {
    id: 'job-1',
    type: 'graph_sync',
    status: 'running',
    payload: {},
    result: null,
    error: null,
    timeout_seconds: 60,
    workspace_id: 'ws-1',
    created_at: '',
    started_at: null,
    completed_at: null,
    updated_at: '',
    ...overrides,
  } as Tables<'jobs'>;
}

function makeRepo(job = makeJob()) {
  return {
    markRunning: vi.fn().mockResolvedValue(job),
    markCompleted: vi.fn().mockResolvedValue(job),
    markFailed: vi.fn().mockResolvedValue(job),
    markTimedOut: vi.fn().mockResolvedValue(job),
  } as unknown as JobRepository;
}

beforeEach(() => {
  live.publishLiveEvent.mockReset().mockResolvedValue(undefined);
});

describe('runJob', () => {
  it('announces the job on the jobs topic when it starts and again after it completes', async () => {
    const repo = makeRepo();

    await runJob(repo, 'job-1', 1_000, async () => ({ ok: true }));

    expect(repo.markCompleted).toHaveBeenCalledWith('job-1', { ok: true });
    expect(live.publishLiveEvent).toHaveBeenCalledTimes(2);
    expect(live.publishLiveEvent).toHaveBeenNthCalledWith(1, 'ws-1', 'jobs', ['job-1']);
    expect(live.publishLiveEvent).toHaveBeenNthCalledWith(2, 'ws-1', 'jobs', ['job-1']);
    // The terminal frame follows the terminal write.
    const completedAt = vi.mocked(repo.markCompleted).mock.invocationCallOrder[0];
    const announcedAt = live.publishLiveEvent.mock.invocationCallOrder[1];
    expect(announcedAt).toBeGreaterThan(completedAt);
  });

  it('announces after a failure as well', async () => {
    const repo = makeRepo();

    await runJob(repo, 'job-1', 1_000, async () => {
      throw new Error('nope');
    });

    expect(repo.markFailed).toHaveBeenCalledWith('job-1', 'nope');
    expect(live.publishLiveEvent).toHaveBeenCalledTimes(2);
  });

  it('announces nothing for a job dispatched outside a workspace', async () => {
    const repo = makeRepo(makeJob({ workspace_id: null }));

    await runJob(repo, 'job-1', 1_000, async () => 'done');

    expect(repo.markCompleted).toHaveBeenCalled();
    expect(live.publishLiveEvent).not.toHaveBeenCalled();
  });
});
