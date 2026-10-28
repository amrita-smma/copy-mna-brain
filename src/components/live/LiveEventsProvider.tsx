'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useEventStream } from '@/hooks/useEventStream';
import { ALL_LIVE_TOPICS, type LiveEvent, type LiveTopic } from '@/lib/live/topics';

export const LIVE_EVENTS_URL = '/api/events';

/**
 * How often a live query refetches on its own while the stream is up. A
 * safety net for a dropped frame, not the update path, so it is slow.
 */
export const LIVE_REFETCH_MS = 60_000;

type TopicListener = (ids: string[] | undefined) => void;

interface LiveEventsContextValue {
  /** The stream is open: updates arrive as they happen. */
  connected: boolean;
  subscribe(topic: LiveTopic, listener: TopicListener): () => void;
}

const LiveEventsContext = createContext<LiveEventsContextValue>({
  connected: false,
  subscribe: () => () => undefined,
});

/**
 * One `GET /api/events` connection for the whole app, mounted in the shell so
 * navigation never reopens it. Every `invalidate` frame becomes
 * `queryClient.invalidateQueries({ queryKey: [topic] })` — a live view is an
 * ordinary `useQuery` whose key starts with its topic (`@/lib/live/topics`)
 * and whose `refetchInterval` is `useLiveRefetchInterval(...)`, so it polls
 * at its old cadence only while the stream is down. A `resync` frame (sent on
 * every connect) invalidates every topic, since pub/sub does not replay.
 *
 * Views that hold their own state rather than a query subscribe with
 * `useLiveTopic`.
 */
export function LiveEventsProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Map<LiveTopic, Set<TopicListener>>());

  const notify = useCallback((topic: LiveTopic, ids: string[] | undefined) => {
    listeners.current.get(topic)?.forEach((listener) => {
      try {
        listener(ids);
      } catch (err) {
        console.error('[live] listener failed:', err);
      }
    });
  }, []);

  const onEvent = useCallback(
    (event: LiveEvent) => {
      if (event.type === 'resync') {
        for (const topic of ALL_LIVE_TOPICS) {
          void queryClient.invalidateQueries({ queryKey: [topic] });
          notify(topic, undefined);
        }
        return;
      }
      if (event.type === 'invalidate') {
        void queryClient.invalidateQueries({ queryKey: [event.topic] });
        notify(event.topic, event.ids);
      }
    },
    [queryClient, notify],
  );

  const onOpen = useCallback(() => setConnected(true), []);
  const onClose = useCallback(() => setConnected(false), []);
  useEventStream<LiveEvent>(enabled ? LIVE_EVENTS_URL : null, onEvent, { onOpen, onClose });

  useEffect(() => {
    if (!enabled) setConnected(false);
  }, [enabled]);

  const subscribe = useCallback((topic: LiveTopic, listener: TopicListener) => {
    let set = listeners.current.get(topic);
    if (!set) {
      set = new Set();
      listeners.current.set(topic, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }, []);

  const value = useMemo(() => ({ connected, subscribe }), [connected, subscribe]);
  return <LiveEventsContext.Provider value={value}>{children}</LiveEventsContext.Provider>;
}

/** Whether the live stream is open right now. */
export function useLiveConnected(): boolean {
  return useContext(LiveEventsContext).connected;
}

/**
 * The `refetchInterval` for a live query: slow while the stream pushes
 * updates, `fallbackMs` (the view's old polling cadence) while it is down —
 * including before it first opens, and on a deployment without Redis.
 */
export function useLiveRefetchInterval(fallbackMs: number): number {
  const connected = useLiveConnected();
  return connected ? LIVE_REFETCH_MS : fallbackMs;
}

/**
 * Run `handler` whenever `topic` is invalidated (with the row ids when the
 * writer named them; undefined on a resync). For views that keep their own
 * state instead of a query. The latest handler is always the one called;
 * re-renders do not resubscribe.
 */
export function useLiveTopic(topic: LiveTopic, handler: TopicListener): void {
  const { subscribe } = useContext(LiveEventsContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => subscribe(topic, (ids) => handlerRef.current(ids)), [subscribe, topic]);
}
