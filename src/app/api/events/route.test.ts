import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  redisConfigured: vi.fn(),
  createRedisSubscriber: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: m.auth }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/server/redis', () => ({
  redisConfigured: m.redisConfigured,
  createRedisSubscriber: m.createRedisSubscriber,
}));

import { GET, HEARTBEAT_MS, STREAM_LIFETIME_MS } from './route';

/** An ioredis subscriber double: records subscriptions, replays messages. */
class FakeSubscriber extends EventEmitter {
  channels: string[] = [];
  quit = vi.fn(async () => 'OK');
  subscribe = vi.fn(async (...channels: string[]) => {
    this.channels.push(...channels);
    return channels.length;
  });
  deliver(event: unknown) {
    this.emit('message', this.channels[0], JSON.stringify(event));
  }
}

const decoder = new TextDecoder();
/** Read SSE frames until `count` frames (data or comment) have arrived. */
async function readFrames(res: Response, count: number): Promise<string[]> {
  const reader = res.body!.getReader();
  const frames: string[] = [];
  let buffer = '';
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      frames.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  reader.releaseLock();
  return frames;
}
const dataOf = (frame: string) => JSON.parse(frame.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join(''));

const request = (signal?: AbortSignal) => new NextRequest('http://localhost/api/events', { signal });

describe('GET /api/events', () => {
  let subscriber: FakeSubscriber;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    m.auth.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    m.redisConfigured.mockReset().mockReturnValue(true);
    subscriber = new FakeSubscriber();
    m.createRedisSubscriber.mockReset().mockReturnValue(subscriber);
  });
  afterEach(() => vi.useRealTimers());

  it('rejects a signed-out request, and refuses without Redis so the clients stay on polling', async () => {
    m.auth.mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(401);

    m.redisConfigured.mockReturnValueOnce(false);
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(m.createRedisSubscriber).not.toHaveBeenCalled();
  });

  it("opens with a resync frame, subscribed to the workspace's events channel only", async () => {
    const res = await GET(request());

    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    const [first] = await readFrames(res, 1);
    expect(dataOf(first)).toEqual({ type: 'resync' });
    expect(subscriber.channels).toEqual(['ws:ws-1:events']);
  });

  it('forwards invalidate frames as published and drops malformed or foreign ones', async () => {
    const res = await GET(request());
    await readFrames(res, 1);

    subscriber.emit('message', 'ws:ws-1:events', '{not json');
    subscriber.deliver({ type: 'presence', chatId: 'c' });
    subscriber.deliver({ type: 'invalidate', topic: 'nope' });
    subscriber.deliver({ type: 'invalidate', topic: 'screenings', ids: ['s1'] });
    subscriber.deliver({ type: 'invalidate', topic: 'workforce' });

    const frames = await readFrames(res, 2);
    expect(frames.map(dataOf)).toEqual([
      { type: 'invalidate', topic: 'screenings', ids: ['s1'] },
      { type: 'invalidate', topic: 'workforce' },
    ]);
  });

  it('sends a heartbeat comment while idle', async () => {
    const res = await GET(request());
    await readFrames(res, 1);

    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);

    const [hb] = await readFrames(res, 1);
    expect(hb).toBe(': hb');
  });

  it('quits the subscriber when the client disconnects', async () => {
    const controller = new AbortController();
    const res = await GET(request(controller.signal));
    await readFrames(res, 1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(subscriber.quit).toHaveBeenCalledTimes(1);
    const { done } = await res.body!.getReader().read();
    expect(done).toBe(true);
  });

  it('closes itself at the lifetime cap so the browser reconnects', async () => {
    const res = await GET(request());
    await readFrames(res, 1);

    await vi.advanceTimersByTimeAsync(STREAM_LIFETIME_MS);

    expect(subscriber.quit).toHaveBeenCalledTimes(1);
    // Drain the heartbeats sent before the cap; the stream then ends.
    const reader = res.body!.getReader();
    let done = false;
    for (let i = 0; i < 50 && !done; i++) done = (await reader.read()).done;
    expect(done).toBe(true);
  });
});
