import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_REFETCH_MS, liveBus, liveFallbackMs, waitForLiveEvent } from './liveBus';
import { LIVE_TOPICS } from './topics';

beforeEach(() => {
  liveBus.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('liveBus', () => {
  it('delivers a frame to every listener of its topic and to no other topic', () => {
    const jobs = vi.fn();
    const files = vi.fn();
    liveBus.subscribe(LIVE_TOPICS.jobs, jobs);
    liveBus.subscribe(LIVE_TOPICS.files, files);

    liveBus.emit(LIVE_TOPICS.jobs, ['j1']);

    expect(jobs).toHaveBeenCalledWith(['j1']);
    expect(files).not.toHaveBeenCalled();
  });

  it('stops delivering after unsubscribe and survives a listener that throws', () => {
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    const off = liveBus.subscribe(LIVE_TOPICS.jobs, bad);
    liveBus.subscribe(LIVE_TOPICS.jobs, good);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    liveBus.emit(LIVE_TOPICS.jobs, undefined);
    off();
    liveBus.emit(LIVE_TOPICS.jobs, undefined);

    expect(good).toHaveBeenCalledTimes(2);
    expect(bad).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});

describe('liveBus connection', () => {
  it('tells connection listeners on each change, not on a repeat of the same state', () => {
    const heard = vi.fn();
    liveBus.onConnectionChange(heard);

    liveBus.setConnected(true);
    liveBus.setConnected(true);
    liveBus.setConnected(false);

    expect(heard.mock.calls).toEqual([[true], [false]]);
  });
});

describe('liveFallbackMs', () => {
  it('is the view cadence while the stream is down and the slow safety net while it is up', () => {
    expect(liveFallbackMs(2_000)).toBe(2_000);
    liveBus.setConnected(true);
    expect(liveFallbackMs(2_000)).toBe(LIVE_REFETCH_MS);
  });
});

describe('waitForLiveEvent', () => {
  it('settles on a frame that names the id, or names no ids', async () => {
    const named = waitForLiveEvent(LIVE_TOPICS.jobs, { id: 'j1', timeoutMs: 10_000 });
    liveBus.emit(LIVE_TOPICS.jobs, ['j1']);
    await expect(named.settled).resolves.toBe('event');

    const resync = waitForLiveEvent(LIVE_TOPICS.jobs, { id: 'j1', timeoutMs: 10_000 });
    liveBus.emit(LIVE_TOPICS.jobs, undefined);
    await expect(resync.settled).resolves.toBe('event');
  });

  it('ignores a frame about another id and times out instead', async () => {
    const wait = waitForLiveEvent(LIVE_TOPICS.jobs, { id: 'j1', timeoutMs: 1_000 });
    liveBus.emit(LIVE_TOPICS.jobs, ['j2']);
    vi.advanceTimersByTime(1_000);
    await expect(wait.settled).resolves.toBe('timeout');
  });

  it('settles disconnected when the stream drops, so a slow wait is re-armed at the fallback cadence', async () => {
    liveBus.setConnected(true);
    const wait = waitForLiveEvent(LIVE_TOPICS.jobs, { id: 'j1', timeoutMs: 60_000 });

    liveBus.setConnected(false);
    await expect(wait.settled).resolves.toBe('disconnected');

    // A later reconnect is not a wake-up for a wait that already ended.
    const next = waitForLiveEvent(LIVE_TOPICS.jobs, { id: 'j1', timeoutMs: 1_000 });
    liveBus.setConnected(true);
    vi.advanceTimersByTime(1_000);
    await expect(next.settled).resolves.toBe('timeout');
  });

  it('settles aborted on cancel or on the signal, and then ignores frames', async () => {
    const cancelled = waitForLiveEvent(LIVE_TOPICS.jobs, { id: 'j1', timeoutMs: 10_000 });
    cancelled.cancel();
    liveBus.emit(LIVE_TOPICS.jobs, ['j1']);
    await expect(cancelled.settled).resolves.toBe('aborted');

    const controller = new AbortController();
    const signalled = waitForLiveEvent(LIVE_TOPICS.jobs, { timeoutMs: 10_000, signal: controller.signal });
    controller.abort();
    await expect(signalled.settled).resolves.toBe('aborted');

    const already = waitForLiveEvent(LIVE_TOPICS.jobs, { timeoutMs: 10_000, signal: controller.signal });
    await expect(already.settled).resolves.toBe('aborted');
  });
});
