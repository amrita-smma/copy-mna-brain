import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// No REDIS_URL in tests: the default client is "not configured", and every
// test that wants Redis passes the in-memory double explicitly.
vi.mock('@/lib/server/redis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/redis')>();
  return {
    ...actual,
    getRedis: vi.fn(() => {
      throw new actual.RedisNotConfiguredError();
    }),
  };
});

import {
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_TTL_SECONDS,
  PresenceCallbackHandler,
  STOP_TTL_SECONDS,
  presenceKey,
  publishBotsChanged,
  publishReply,
  readPresence,
  requestStopSignal,
  startTurnPresence,
  stopKey,
  watchStop,
  type PresenceRedis,
} from './presence';
import { SUMMARIZATION_SOURCE } from './summary';

/** An in-memory stand-in for the ioredis commands this module uses. */
class FakeRedis implements PresenceRedis {
  strings = new Map<string, { value: string; ex?: number }>();
  published: { channel: string; event: Record<string, unknown> }[] = [];
  failing = new Set<string>();

  private fail(cmd: string) {
    if (this.failing.has(cmd)) throw new Error(`${cmd} down`);
  }

  set = vi.fn(async (key: string, value: string, ...args: unknown[]) => {
    this.fail('set');
    const ex = args[0] === 'EX' ? Number(args[1]) : undefined;
    this.strings.set(key, { value, ex });
    return 'OK';
  }) as unknown as PresenceRedis['set'];

  get = vi.fn(async (key: string) => {
    this.fail('get');
    return this.strings.get(key)?.value ?? null;
  }) as unknown as PresenceRedis['get'];

  mget = vi.fn(async (...keys: string[]) => {
    this.fail('mget');
    return keys.map((k) => this.strings.get(k)?.value ?? null);
  }) as unknown as PresenceRedis['mget'];

  del = vi.fn(async (...keys: string[]) => {
    this.fail('del');
    let n = 0;
    for (const k of keys) {
      if (this.strings.delete(k)) n++;
    }
    return n;
  }) as unknown as PresenceRedis['del'];

  publish = vi.fn(async (channel: string, message: string) => {
    this.fail('publish');
    this.published.push({ channel, event: JSON.parse(message) });
    return 1;
  }) as unknown as PresenceRedis['publish'];

  presence(chatId: string) {
    const raw = this.strings.get(presenceKey(chatId));
    return raw ? { ...JSON.parse(raw.value), ex: raw.ex } : null;
  }

  events(type?: string) {
    return this.published.filter((p) => !type || p.event.type === type).map((p) => p.event);
  }
}

// Lets the module's fire-and-forget Redis promises settle; works under fake timers too.
const flush = () => vi.advanceTimersByTimeAsync(0);

const turn = { workspaceId: 'ws', userId: 'u1', chatId: 'chat-a', botId: 'bot-a', turnId: 't1' };

describe('startTurnPresence', () => {
  let redis: FakeRedis;
  beforeEach(() => {
    redis = new FakeRedis();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it('clears a stale Stop, marks the turn thinking with a TTL, and tells the user’s channel', async () => {
    redis.strings.set(stopKey('chat-a'), { value: '1' });

    startTurnPresence(turn, redis);
    await flush();

    expect(redis.strings.has(stopKey('chat-a'))).toBe(false);
    expect(redis.presence('chat-a')).toMatchObject({ botId: 'bot-a', phase: 'thinking', turnId: 't1', ex: PRESENCE_TTL_SECONDS });
    expect(redis.published[0]).toEqual({
      channel: 'ws:ws:user:u1',
      event: { type: 'presence', chatId: 'chat-a', botId: 'bot-a', turnId: 't1', phase: 'thinking' },
    });
  });

  it('re-sets the key on every heartbeat so it outlives a slow turn but not a dead one', async () => {
    startTurnPresence(turn, redis);
    await flush();
    const writes = (redis.set as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS * 3);

    expect((redis.set as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(writes + 3);
    // Heartbeats are silent: only phase changes are published.
    expect(redis.events('presence')).toHaveLength(1);
  });

  it('publishes a phase only when it changes, and nothing after done()', async () => {
    const presence = startTurnPresence(turn, redis);
    await flush();

    presence.setPhase('thinking');
    presence.setPhase('working');
    presence.setPhase('working');
    presence.setPhase('talking');
    await flush();
    expect(redis.events('presence').map((e) => e.phase)).toEqual(['thinking', 'working', 'talking']);

    await presence.done();
    await presence.done();
    presence.setPhase('thinking');
    await vi.advanceTimersByTimeAsync(PRESENCE_HEARTBEAT_MS * 2);

    expect(redis.presence('chat-a')).toBeNull();
    const phases = redis.events('presence').map((e) => e.phase);
    expect(phases).toEqual(['thinking', 'working', 'talking', null]);
  });

  it('never throws into the turn when Redis is down, and logs once per command', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    redis.failing.add('set').add('publish').add('del');

    const presence = startTurnPresence(turn, redis);
    await flush();
    presence.setPhase('working');
    await flush();
    await expect(presence.done()).resolves.toBeUndefined();

    const kinds = error.mock.calls.map((c) => String(c[0]));
    expect(kinds.filter((k) => k.includes('set presence'))).toHaveLength(1);
    error.mockRestore();
  });

  it('is a no-op without Redis', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const presence = startTurnPresence(turn);
    presence.setPhase('working');
    await expect(presence.done()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('REDIS_URL is not set'));
    error.mockRestore();
  });
});

describe('PresenceCallbackHandler', () => {
  it('maps model start, tool start and tokens to phases', async () => {
    const phases: string[] = [];
    const handler = new PresenceCallbackHandler((p) => phases.push(p));

    await handler.handleChatModelStart({}, [], 'run-1', 'parent');
    await handler.handleToolStart({}, 'input', 'run-2', 'run-1');
    await handler.handleLLMStart({}, [], 'run-3', 'parent');
    await handler.handleLLMNewToken('Hel', 0 as never, 'run-3', 'parent');
    await handler.handleLLMNewToken('', 0 as never, 'run-3', 'parent', undefined, {
      chunk: { message: { content: [{ type: 'thinking', thinking: '…' }] } },
    });

    expect(phases).toEqual(['thinking', 'working', 'thinking', 'talking', 'thinking']);
  });

  it('ignores the summarization middleware’s own model runs, tokens included', async () => {
    const phases: string[] = [];
    const handler = new PresenceCallbackHandler((p) => phases.push(p));

    await handler.handleChatModelStart({}, [], 'sum-1', 'agent', undefined, undefined, {
      lc_source: SUMMARIZATION_SOURCE,
    });
    await handler.handleLLMNewToken('summary…', 0 as never, 'sum-1', 'agent');
    await handler.handleToolStart({}, 'x', 'child', 'sum-1');

    expect(phases).toEqual([]);
  });
});

describe('watchStop / requestStopSignal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('aborts once Stop is set, and stops polling after', async () => {
    const redis = new FakeRedis();
    const watch = watchStop('chat-a', { redis, intervalMs: 100 });

    await vi.advanceTimersByTimeAsync(250);
    expect(watch.signal.aborted).toBe(false);

    await requestStopSignal('chat-a', redis);
    expect(redis.strings.get(stopKey('chat-a'))).toEqual({ value: '1', ex: STOP_TTL_SECONDS });
    await vi.advanceTimersByTimeAsync(100);
    expect(watch.signal.aborted).toBe(true);

    const gets = (redis.get as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect((redis.get as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(gets);
  });

  it('dispose() stops polling without aborting', async () => {
    const redis = new FakeRedis();
    const watch = watchStop('chat-a', { redis, intervalMs: 100 });
    watch.dispose();
    await requestStopSignal('chat-a', redis);
    await vi.advanceTimersByTimeAsync(300);
    expect(watch.signal.aborted).toBe(false);
    expect(redis.get).not.toHaveBeenCalled();
  });
});

describe('readPresence', () => {
  it('returns the running turns and skips missing or malformed keys', async () => {
    const redis = new FakeRedis();
    redis.strings.set(presenceKey('a'), { value: JSON.stringify({ chatId: 'a', botId: 'b', phase: 'working' }) });
    redis.strings.set(presenceKey('c'), { value: '{not json' });

    const out = await readPresence(['a', 'missing', 'c'], redis);

    expect([...out.keys()]).toEqual(['a']);
    expect(out.get('a')).toMatchObject({ phase: 'working' });
    expect((await readPresence([], redis)).size).toBe(0);
    expect(redis.mget).toHaveBeenCalledTimes(1);
  });
});

describe('publishReply / publishBotsChanged', () => {
  it('sends a reply to the user’s channel and bots-changed to the user or the workspace', async () => {
    const redis = new FakeRedis();

    await publishReply('ws', 'u1', { chatId: 'chat-a', botId: 'bot-a', turnId: 't9' }, redis);
    await publishBotsChanged('ws', 'u1', redis);
    await publishBotsChanged('ws', null, redis);

    expect(redis.published).toEqual([
      { channel: 'ws:ws:user:u1', event: { type: 'reply', chatId: 'chat-a', botId: 'bot-a', turnId: 't9' } },
      { channel: 'ws:ws:user:u1', event: { type: 'bots-changed' } },
      { channel: 'ws:ws', event: { type: 'bots-changed' } },
    ]);
  });
});
