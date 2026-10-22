import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  createContainer: vi.fn(),
  list: vi.fn(),
  redisConfigured: vi.fn(),
  createRedisSubscriber: vi.fn(),
  readPresence: vi.fn(),
}));

vi.mock('@/auth', () => ({ auth: m.auth }));
vi.mock('@/lib/server/db', () => ({ createDb: vi.fn(() => ({})) }));
vi.mock('@/lib/workspace', () => ({ getActiveWorkspaceId: vi.fn(async () => 'ws-1') }));
vi.mock('@/lib/services/container', () => ({ createContainer: m.createContainer }));
vi.mock('@/lib/server/redis', () => ({
  redisConfigured: m.redisConfigured,
  createRedisSubscriber: m.createRedisSubscriber,
}));
vi.mock('@/lib/bots/presence', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readPresence: m.readPresence,
}));

import { GET, RECONCILE_MS } from './route';
import { botDto } from '@/lib/bots/testing/botFixtures';

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
/** Read SSE frames until `count` `data:` payloads have arrived. */
async function readEvents(res: Response, count: number): Promise<Record<string, unknown>[]> {
  const reader = res.body!.getReader();
  const events: Record<string, unknown>[] = [];
  let buffer = '';
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value);
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = frame
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('');
      if (data) events.push(JSON.parse(data));
    }
  }
  reader.releaseLock();
  return events;
}

const request = (signal?: AbortSignal) => new NextRequest('http://localhost/api/bots/events', { signal });

describe('GET /api/bots/events', () => {
  let subscriber: FakeSubscriber;
  const scout = botDto({ id: 'scout', thread_id: 'chat-scout' });
  const atlas = botDto({ id: 'atlas', name: 'Atlas', thread_id: 'chat-atlas' });
  const fresh = botDto({ id: 'fresh', name: 'Fresh', thread_id: null });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    m.auth.mockReset().mockResolvedValue({ user: { id: 'u1' } });
    m.redisConfigured.mockReset().mockReturnValue(true);
    subscriber = new FakeSubscriber();
    m.createRedisSubscriber.mockReset().mockReturnValue(subscriber);
    m.list.mockReset().mockResolvedValue([scout, atlas, fresh]);
    m.createContainer.mockReset().mockReturnValue({ botService: { list: m.list } });
    m.readPresence.mockReset().mockResolvedValue(new Map());
  });
  afterEach(() => vi.useRealTimers());

  it('rejects a signed-out request, and refuses without Redis', async () => {
    m.auth.mockResolvedValueOnce(null);
    expect((await GET(request())).status).toBe(401);

    m.redisConfigured.mockReturnValueOnce(false);
    const res = await GET(request());
    expect(res.status).toBe(503);
    expect(m.createRedisSubscriber).not.toHaveBeenCalled();
  });

  it("opens with a snapshot of the user's bots and their live state, subscribed to both channels", async () => {
    const presence = { chatId: 'chat-scout', botId: 'scout', userId: 'u1', phase: 'working', since: 's', turnId: 't1' };
    m.readPresence.mockResolvedValue(new Map([['chat-scout', presence]]));

    const res = await GET(request());

    expect(res.headers.get('Content-Type')).toContain('text/event-stream');
    const [snapshot] = await readEvents(res, 1);
    expect(snapshot).toEqual({
      type: 'snapshot',
      bots: [scout, atlas, fresh],
      presence: [presence],
    });
    // Only opened threads have live keys to read.
    expect(m.readPresence).toHaveBeenCalledWith(['chat-scout', 'chat-atlas']);
    expect(subscriber.channels).toEqual(['ws:ws-1:user:u1', 'ws:ws-1']);
  });

  it('forwards channel events to the client and ignores malformed ones', async () => {
    const res = await GET(request());
    await readEvents(res, 1);

    subscriber.emit('message', 'ws:ws-1:user:u1', '{not json');
    subscriber.emit('message', 'ws:ws-1:user:u1', JSON.stringify({ type: 'nope' }));
    subscriber.deliver({ type: 'reply', chatId: 'chat-scout', botId: 'scout', turnId: 't2' });

    const [reply] = await readEvents(res, 1);
    expect(reply).toEqual({ type: 'reply', chatId: 'chat-scout', botId: 'scout', turnId: 't2' });
  });

  it('re-reads the bot list when bots change, so a new thread is watched', async () => {
    const res = await GET(request());
    await readEvents(res, 1);
    m.list.mockResolvedValue([scout, atlas, botDto({ ...fresh, thread_id: 'chat-fresh' })]);

    subscriber.deliver({ type: 'bots-changed' });
    const [changed, snapshot] = await readEvents(res, 2);

    expect(changed).toEqual({ type: 'bots-changed' });
    expect(snapshot).toMatchObject({ type: 'snapshot' });
    expect(m.readPresence).toHaveBeenLastCalledWith(['chat-scout', 'chat-atlas', 'chat-fresh']);
  });

  it('announces a presence key that expired without a message, on the next tick', async () => {
    const presence = { chatId: 'chat-scout', botId: 'scout', userId: 'u1', phase: 'thinking', since: 's', turnId: 't1' };
    m.readPresence.mockResolvedValueOnce(new Map([['chat-scout', presence]])).mockResolvedValue(new Map());

    const res = await GET(request());
    await readEvents(res, 1);
    await vi.advanceTimersByTimeAsync(RECONCILE_MS);

    const [gone] = await readEvents(res, 1);
    expect(gone).toEqual({ type: 'presence', chatId: 'chat-scout', botId: 'scout', turnId: 't1', phase: null });
  });

  it('does not re-announce a change the channel already delivered', async () => {
    const res = await GET(request());
    await readEvents(res, 1);
    subscriber.deliver({ type: 'presence', chatId: 'chat-scout', botId: 'scout', turnId: 't1', phase: 'thinking' });
    await readEvents(res, 1);
    m.readPresence.mockResolvedValue(
      new Map([['chat-scout', { chatId: 'chat-scout', botId: 'scout', userId: 'u1', phase: 'thinking', since: 's', turnId: 't1' }]]),
    );

    await vi.advanceTimersByTimeAsync(RECONCILE_MS);
    // Only a heartbeat comment went out: the next data frame is the one we send now.
    subscriber.deliver({ type: 'bots-changed' });
    const [next] = await readEvents(res, 1);
    expect(next).toEqual({ type: 'bots-changed' });
  });

  it('quits the subscriber when the client disconnects', async () => {
    const controller = new AbortController();
    const res = await GET(request(controller.signal));
    await readEvents(res, 1);

    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(subscriber.quit).toHaveBeenCalledTimes(1);
    const { done } = await res.body!.getReader().read();
    expect(done).toBe(true);
  });
});
