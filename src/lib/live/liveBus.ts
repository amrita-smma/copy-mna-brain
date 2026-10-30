/**
 * The browser side of the live-updates stream, as a plain module so code
 * that is not a React hook — a promise waiting on a job — can hear frames.
 * `LiveEventsProvider` feeds it (every `invalidate` and `resync` frame, and
 * whether the stream is open); `useLiveTopic` and `waitForLiveEvent` read it.
 * Client-safe: no React, no server imports.
 */
import type { LiveTopic } from './topics';

/**
 * How often a live view refetches on its own while the stream is up. A
 * safety net for a dropped frame, not the update path, so it is slow.
 */
export const LIVE_REFETCH_MS = 60_000;

export type LiveTopicListener = (ids: string[] | undefined) => void;

const listeners = new Map<LiveTopic, Set<LiveTopicListener>>();
const connectionListeners = new Set<(connected: boolean) => void>();
let connected = false;

export const liveBus = {
  /** The stream is open: updates arrive as they happen. */
  isConnected(): boolean {
    return connected;
  },
  setConnected(value: boolean): void {
    if (connected === value) return;
    connected = value;
    connectionListeners.forEach((listener) => {
      try {
        listener(value);
      } catch (err) {
        console.error('[live] connection listener failed:', err);
      }
    });
  },
  /** Hear the stream open and close. */
  onConnectionChange(listener: (connected: boolean) => void): () => void {
    connectionListeners.add(listener);
    return () => {
      connectionListeners.delete(listener);
    };
  },
  subscribe(topic: LiveTopic, listener: LiveTopicListener): () => void {
    let set = listeners.get(topic);
    if (!set) {
      set = new Set();
      listeners.set(topic, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  },
  /** `ids` names the rows when the writer knew them; undefined on a resync. */
  emit(topic: LiveTopic, ids: string[] | undefined): void {
    listeners.get(topic)?.forEach((listener) => {
      try {
        listener(ids);
      } catch (err) {
        console.error('[live] listener failed:', err);
      }
    });
  },
  /** Tests only. */
  reset(): void {
    listeners.clear();
    connectionListeners.clear();
    connected = false;
  },
};

/**
 * How long a poller should wait before asking again: `fallbackMs` (its old
 * cadence) while the stream is down, the slow safety-net interval while it
 * is up and will deliver the change as a frame.
 */
export function liveFallbackMs(fallbackMs: number): number {
  return connected ? LIVE_REFETCH_MS : fallbackMs;
}

export type LiveWaitOutcome = 'event' | 'timeout' | 'disconnected' | 'aborted';

export interface LiveWait {
  /** Why the wait ended. */
  settled: Promise<LiveWaitOutcome>;
  /** Stop waiting (nothing is published; `settled` resolves 'aborted'). */
  cancel(): void;
}

/**
 * Wait for a frame on `topic` that names `id` (or names no ids), for
 * `timeoutMs`, or for the stream to drop — whichever comes first. A wait
 * armed at the slow safety-net interval must not outlive the stream it
 * trusted: on 'disconnected' the caller re-reads and re-arms at its fallback
 * cadence. Start the wait *before* the read it follows up, so a frame that
 * lands during the read is not missed.
 */
export function waitForLiveEvent(
  topic: LiveTopic,
  opts: { id?: string; timeoutMs: number; signal?: AbortSignal },
): LiveWait {
  let finish: (why: LiveWaitOutcome) => void = () => undefined;
  const settled = new Promise<LiveWaitOutcome>((resolve) => {
    finish = resolve;
  });
  const unsubscribe = liveBus.subscribe(topic, (ids) => {
    if (ids && opts.id && !ids.includes(opts.id)) return;
    done('event');
  });
  const stopHearingConnection = liveBus.onConnectionChange((isConnected) => {
    if (!isConnected) done('disconnected');
  });
  const timer = setTimeout(() => done('timeout'), opts.timeoutMs);
  const onAbort = () => done('aborted');
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  let over = false;
  function done(why: LiveWaitOutcome) {
    if (over) return;
    over = true;
    unsubscribe();
    stopHearingConnection();
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    finish(why);
  }

  if (opts.signal?.aborted) done('aborted');
  return { settled, cancel: () => done('aborted') };
}
