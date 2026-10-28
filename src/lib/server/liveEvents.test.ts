import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const m = vi.hoisted(() => ({ getRedis: vi.fn() }));

vi.mock('@/lib/server/redis', () => {
  class RedisNotConfiguredError extends Error {}
  return { getRedis: m.getRedis, RedisNotConfiguredError };
});

import { liveEventsChannel, publishLiveEvent } from './liveEvents';
import { RedisNotConfiguredError } from '@/lib/server/redis';
import { LIVE_TOPICS } from '@/lib/live/topics';

describe('liveEventsChannel', () => {
  it('is one channel per workspace, distinct from the bots channels', () => {
    expect(liveEventsChannel('ws-1')).toBe('ws:ws-1:events');
  });
});

describe('publishLiveEvent', () => {
  beforeEach(() => {
    m.getRedis.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('publishes an invalidate frame for the topic on the workspace channel, with the ids when given', async () => {
    const redis = { publish: vi.fn(async () => 1) };

    await publishLiveEvent('ws-1', LIVE_TOPICS.screenings, ['s1', 's2'], redis);
    await publishLiveEvent('ws-1', LIVE_TOPICS.workforce, undefined, redis);
    await publishLiveEvent('ws-1', LIVE_TOPICS.sourcing, [], redis);

    expect(redis.publish.mock.calls).toEqual([
      ['ws:ws-1:events', JSON.stringify({ type: 'invalidate', topic: 'screenings', ids: ['s1', 's2'] })],
      ['ws:ws-1:events', JSON.stringify({ type: 'invalidate', topic: 'workforce' })],
      ['ws:ws-1:events', JSON.stringify({ type: 'invalidate', topic: 'sourcing' })],
    ]);
  });

  it('uses the process client by default', async () => {
    const redis = { publish: vi.fn(async () => 1) };
    m.getRedis.mockReturnValue(redis);

    await publishLiveEvent('ws-1', LIVE_TOPICS.aiOpinion, ['c1']);

    expect(redis.publish).toHaveBeenCalledWith(
      'ws:ws-1:events',
      JSON.stringify({ type: 'invalidate', topic: 'ai-opinion', ids: ['c1'] }),
    );
  });

  it('is a no-op without Redis configured, and never throws on a publish failure', async () => {
    m.getRedis.mockImplementation(() => {
      throw new RedisNotConfiguredError();
    });
    await expect(publishLiveEvent('ws-1', LIVE_TOPICS.workforce)).resolves.toBeUndefined();

    const failing = { publish: vi.fn(async () => { throw new Error('down'); }) };
    await expect(publishLiveEvent('ws-1', LIVE_TOPICS.workforce, ['r1'], failing)).resolves.toBeUndefined();
    expect(failing.publish).toHaveBeenCalledTimes(1);
  });

  it('does nothing when handed a null client', async () => {
    await expect(publishLiveEvent('ws-1', LIVE_TOPICS.workforce, ['r1'], null)).resolves.toBeUndefined();
    expect(m.getRedis).not.toHaveBeenCalled();
  });
});
