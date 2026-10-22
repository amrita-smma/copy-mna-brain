/**
 * Live bot state in Redis: which bot is thinking right now, Stop signals for
 * running turns, and the pub/sub events that reach the browsers through
 * `GET /api/bots/events`. Postgres stays the source of truth
 * for everything durable, including the turn lock (`claimTurn`); what lives
 * here expires on its own, so a crashed turn's marker clears within
 * `PRESENCE_TTL_SECONDS` instead of the lock's ten minutes.
 *
 * Every writer — the interactive chat route, a background bot turn, a routine,
 * bot CRUD — goes through this module, so there is one key layout:
 *
 *   bot:presence:{chatId}   JSON BotPresence, EX 30, re-set every 10 s
 *   chat:stop:{chatId}      "1", EX 900: Stop was pressed on the running turn
 *   ws:{workspaceId}:user:{userId}   channel: that user's bot events
 *   ws:{workspaceId}                 channel: bots-changed for everyone
 *
 * A Redis failure never fails a turn: every command is wrapped, logged once
 * per kind, and otherwise ignored — the live indicators degrade, chat does not.
 */
import type Redis from 'ioredis';
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { getRedis, RedisNotConfiguredError } from '@/lib/server/redis';
import { SUMMARIZATION_SOURCE } from './summary';
import type { BotLiveEvent, BotPresence } from './presenceTypes';

export const PRESENCE_TTL_SECONDS = 30;
export const PRESENCE_HEARTBEAT_MS = 10_000;
export const STOP_TTL_SECONDS = 900;
/** How often a running turn checks for Stop. */
export const STOP_POLL_MS = 1_000;

/** The subset of ioredis this module uses; tests pass an in-memory double. */
export type PresenceRedis = Pick<Redis, 'set' | 'get' | 'mget' | 'del' | 'publish'>;

export const presenceKey = (chatId: string) => `bot:presence:${chatId}`;
export const stopKey = (chatId: string) => `chat:stop:${chatId}`;
export const userChannel = (workspaceId: string, userId: string) => `ws:${workspaceId}:user:${userId}`;
export const workspaceChannel = (workspaceId: string) => `ws:${workspaceId}`;

const warned = new Set<string>();

/** Run a Redis command; on failure log once per `what` and return undefined. */
async function safe<T>(what: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (err) {
    if (!warned.has(what)) {
      warned.add(what);
      console.error(`[redis] ${what} failed (further failures of this kind are not logged):`, err);
    }
    return undefined;
  }
}

/** The process client, or null (logged once) when Redis is not configured. */
function clientOrNull(): PresenceRedis | null {
  try {
    return getRedis();
  } catch (err) {
    if (err instanceof RedisNotConfiguredError) {
      if (!warned.has('configured')) {
        warned.add('configured');
        console.error(`[redis] ${err.message}`);
      }
      return null;
    }
    throw err;
  }
}

function publish(redis: PresenceRedis, channel: string, event: BotLiveEvent): Promise<unknown> {
  return safe(`publish ${event.type}`, () => redis.publish(channel, JSON.stringify(event)));
}

export interface TurnPresenceInput {
  workspaceId: string;
  userId: string;
  chatId: string;
  botId: string;
  turnId: string;
}

export interface TurnPresence {
  setPhase(phase: BotPresence['phase']): void;
  /** Idempotent: clears the heartbeat and the key, and tells the clients. */
  done(): Promise<void>;
}

/**
 * Mark a turn as running on `chatId` until `done()`. Clears a stale Stop
 * first: a Stop pressed after the previous turn's agent had finished (but
 * before its lock was released) must not kill this one.
 */
export function startTurnPresence(input: TurnPresenceInput, redis: PresenceRedis | null = clientOrNull()): TurnPresence {
  if (!redis) return { setPhase: () => undefined, done: async () => undefined };
  const { workspaceId, userId, chatId, botId, turnId } = input;
  const channel = userChannel(workspaceId, userId);
  const since = new Date().toISOString();
  let phase: BotPresence['phase'] = 'thinking';
  let finished = false;

  // `p` is captured per call: two quick transitions must each announce their
  // own phase, not whatever `phase` holds once the writes have settled.
  const write = (p: BotPresence['phase']) => {
    const presence: BotPresence = { chatId, botId, userId, phase: p, since, turnId };
    return safe('set presence', () => redis.set(presenceKey(chatId), JSON.stringify(presence), 'EX', PRESENCE_TTL_SECONDS));
  };
  const announce = (p: BotPresence['phase']) =>
    publish(redis, channel, { type: 'presence', chatId, botId, turnId, phase: p });

  void safe('clear stop', () => redis.del(stopKey(chatId)));
  void write(phase).then(() => announce(phase));
  const heartbeat = setInterval(() => void write(phase), PRESENCE_HEARTBEAT_MS);
  heartbeat.unref?.();

  return {
    setPhase(next) {
      if (finished || next === phase) return;
      phase = next;
      void write(next).then(() => announce(next));
    },
    async done() {
      if (finished) return;
      finished = true;
      clearInterval(heartbeat);
      await safe('del presence', () => redis.del(presenceKey(chatId)));
      await publish(redis, channel, { type: 'presence', chatId, botId, turnId, phase: null });
    },
  };
}

/**
 * The one phase detector, for `agent.invoke` and `agent.streamEvents` alike
 * (both take `callbacks`). Runs started by the summarization middleware are
 * ignored, by run id, so the summarizer never flips the phase.
 */
export class PresenceCallbackHandler extends BaseCallbackHandler {
  name = 'bot_presence';
  private readonly ignoredRuns = new Set<string>();

  constructor(private readonly setPhase: (phase: BotPresence['phase']) => void) {
    super();
  }

  private ignored(runId: string, parentRunId?: string): boolean {
    return this.ignoredRuns.has(runId) || (parentRunId !== undefined && this.ignoredRuns.has(parentRunId));
  }

  private startModel(runId: string, parentRunId?: string, metadata?: Record<string, unknown>) {
    if (metadata?.lc_source === SUMMARIZATION_SOURCE) {
      this.ignoredRuns.add(runId);
      return;
    }
    if (this.ignored(runId, parentRunId)) return;
    this.setPhase('thinking');
  }

  handleLLMStart(
    _llm: unknown,
    _prompts: string[],
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ) {
    this.startModel(runId, parentRunId, metadata);
  }

  handleChatModelStart(
    _llm: unknown,
    _messages: unknown,
    runId: string,
    parentRunId?: string,
    _extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ) {
    this.startModel(runId, parentRunId, metadata);
  }

  handleLLMNewToken(
    token: string,
    _idx: unknown,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    fields?: { chunk?: unknown },
  ) {
    if (this.ignored(runId, parentRunId)) return;
    this.setPhase(isThinkingChunk(fields?.chunk) ? 'thinking' : token ? 'talking' : 'thinking');
  }

  handleToolStart(_tool: unknown, _input: string, runId: string, parentRunId?: string) {
    if (this.ignored(runId, parentRunId)) return;
    this.setPhase('working');
  }
}

/** An Anthropic extended-thinking chunk, as `handleLLMNewToken` receives it. */
function isThinkingChunk(chunk: unknown): boolean {
  const content = (chunk as { message?: { content?: unknown } } | undefined)?.message?.content;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    const type = (block as { type?: unknown })?.type;
    return type === 'thinking' || type === 'reasoning';
  });
}

export interface StopWatch {
  signal: AbortSignal;
  dispose(): void;
}

/** Abort `signal` once Stop is pressed on the thread's running turn. */
export function watchStop(
  chatId: string,
  opts: { redis?: PresenceRedis | null; intervalMs?: number } = {},
): StopWatch {
  const redis = opts.redis === undefined ? clientOrNull() : opts.redis;
  const controller = new AbortController();
  if (!redis) return { signal: controller.signal, dispose: () => undefined };
  let checking = false;
  const timer = setInterval(() => {
    if (checking || controller.signal.aborted) return;
    checking = true;
    void safe('get stop', () => redis.get(stopKey(chatId)))
      .then((value) => {
        if (value) {
          controller.abort();
          clearInterval(timer);
        }
      })
      .finally(() => {
        checking = false;
      });
  }, opts.intervalMs ?? STOP_POLL_MS);
  timer.unref?.();
  return { signal: controller.signal, dispose: () => clearInterval(timer) };
}

/** Stop was pressed: the running turn on `chatId` picks it up within `STOP_POLL_MS`. */
export async function requestStopSignal(chatId: string, redis: PresenceRedis | null = clientOrNull()): Promise<void> {
  if (!redis) return;
  await safe('set stop', () => redis.set(stopKey(chatId), '1', 'EX', STOP_TTL_SECONDS));
}

/** The running turns on these chats. Missing and malformed keys are left out. */
export async function readPresence(
  chatIds: readonly string[],
  redis: PresenceRedis | null = clientOrNull(),
): Promise<Map<string, BotPresence>> {
  const out = new Map<string, BotPresence>();
  if (!redis || chatIds.length === 0) return out;
  const values = await safe('mget presence', () => redis.mget(...chatIds.map(presenceKey)));
  values?.forEach((raw, i) => {
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as BotPresence;
      if (parsed && typeof parsed.phase === 'string') out.set(chatIds[i], parsed);
    } catch {
      // A malformed value is treated as absent.
    }
  });
  return out;
}

/** A turn was stored in the user's thread with the bot. */
export async function publishReply(
  workspaceId: string,
  userId: string,
  reply: { chatId: string; botId: string; turnId: string },
  redis: PresenceRedis | null = clientOrNull(),
): Promise<void> {
  if (!redis) return;
  await publish(redis, userChannel(workspaceId, userId), { type: 'reply', ...reply });
}

/**
 * A bot was created, changed, archived or re-pinned. `userId` for a change
 * only that user sees (a private bot, their pins); null for one everyone
 * sees (a shared bot).
 */
export async function publishBotsChanged(
  workspaceId: string,
  userId: string | null,
  redis: PresenceRedis | null = clientOrNull(),
): Promise<void> {
  if (!redis) return;
  const channel = userId ? userChannel(workspaceId, userId) : workspaceChannel(workspaceId);
  await publish(redis, channel, { type: 'bots-changed' });
}
