import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { apiRequest } = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock('@/lib/api/client', () => ({ apiRequest }));

import { liveBus } from '@/lib/live/liveBus';
import { LIVE_TOPICS } from '@/lib/live/topics';
import { waitForJob, waitForWorkforceRun } from './useJob';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  liveBus.reset();
  apiRequest.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('waitForJob', () => {
  it('returns a job that is already terminal after one read', async () => {
    apiRequest.mockResolvedValueOnce({ id: 'j1', status: 'completed', logs: [] });

    await expect(waitForJob('j1')).resolves.toMatchObject({ status: 'completed' });
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it('re-reads when the stream names the job, not on a timer, while the stream is up', async () => {
    vi.useFakeTimers();
    liveBus.setConnected(true);
    apiRequest
      .mockResolvedValueOnce({ id: 'j1', status: 'running', logs: [] })
      .mockResolvedValueOnce({ id: 'j1', status: 'completed', logs: [] });

    const done = waitForJob('j1', { intervalMs: 2_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(apiRequest).toHaveBeenCalledTimes(1);

    liveBus.emit(LIVE_TOPICS.jobs, ['other']);
    await vi.advanceTimersByTimeAsync(0);
    expect(apiRequest).toHaveBeenCalledTimes(1);

    liveBus.emit(LIVE_TOPICS.jobs, ['j1']);
    await expect(done).resolves.toMatchObject({ status: 'completed' });
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it('falls back to the interval while the stream is down', async () => {
    vi.useFakeTimers();
    apiRequest
      .mockResolvedValueOnce({ id: 'j1', status: 'pending', logs: [] })
      .mockResolvedValueOnce({ id: 'j1', status: 'failed', logs: [] });

    const done = waitForJob('j1', { intervalMs: 2_000 });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(done).resolves.toMatchObject({ status: 'failed' });
    expect(apiRequest).toHaveBeenCalledTimes(2);
  });

  it('re-reads at the short interval as soon as the stream drops mid-wait', async () => {
    vi.useFakeTimers();
    liveBus.setConnected(true);
    apiRequest
      .mockResolvedValueOnce({ id: 'j1', status: 'running', logs: [] })
      .mockResolvedValueOnce({ id: 'j1', status: 'running', logs: [] })
      .mockResolvedValueOnce({ id: 'j1', status: 'completed', logs: [] });

    const done = waitForJob('j1', { intervalMs: 2_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(apiRequest).toHaveBeenCalledTimes(1);

    // The stream drops: one read now, then the 2 s cadence, not the 60 s one.
    liveBus.setConnected(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(apiRequest).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(done).resolves.toMatchObject({ status: 'completed' });
    expect(apiRequest).toHaveBeenCalledTimes(3);
  });

  it('rejects when aborted while waiting and when the read fails', async () => {
    const controller = new AbortController();
    apiRequest.mockResolvedValueOnce({ id: 'j1', status: 'running', logs: [] });
    const waiting = waitForJob('j1', { signal: controller.signal, intervalMs: 60_000 });
    await flush();
    controller.abort();
    await expect(waiting).rejects.toThrow('Aborted');

    apiRequest.mockRejectedValueOnce(new Error('HTTP 500'));
    await expect(waitForJob('j2')).rejects.toThrow('HTTP 500');
  });
});

describe('waitForWorkforceRun', () => {
  it('follows the workforce topic for the run and maps the terminal row', async () => {
    liveBus.setConnected(true);
    apiRequest
      .mockResolvedValueOnce({ item: { status: 'running' } })
      .mockResolvedValueOnce({ item: { status: 'failed', error: { message: 'no budget' } } });

    const done = waitForWorkforceRun('r1');
    await flush();
    liveBus.emit(LIVE_TOPICS.workforce, ['r1']);

    await expect(done).resolves.toEqual({ status: 'failed', result: null, error: 'no budget' });
    expect(apiRequest).toHaveBeenCalledWith('/api/workforce-queue/r1', expect.anything());
  });
});
