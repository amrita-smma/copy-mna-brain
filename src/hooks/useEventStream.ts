import { useEffect, useRef } from 'react';

/** Reconnect backoff after the browser gives up on a stream: first wait, and the cap. */
export const EVENT_STREAM_RETRY_MIN_MS = 1_000;
export const EVENT_STREAM_RETRY_MAX_MS = 30_000;

/**
 * Subscribe to a Server-Sent Events endpoint.
 *
 * Pass `url = null` to stay disconnected (e.g. while nothing is in flight) —
 * this is how callers gate the connection on/off cheaply. `onMessage` receives
 * each parsed `data:` payload; heartbeat comment frames are ignored by
 * `EventSource` and never reach it. The connection is torn down on unmount or
 * when `url` changes.
 *
 * The browser retries a dropped stream on its own (including when the server
 * closes it at its lifetime cap). It does NOT retry after a response that is
 * not a stream — a 401 while the session was refreshing, a 503 while a
 * dependency was down, a 500 — it just goes CLOSED, and a bare `EventSource`
 * then stays silent until the page is reloaded. So a CLOSED source is
 * reopened here with a backoff (1 s, doubling to 30 s, reset once a stream
 * opens), and a page left open keeps receiving once the server is well again.
 *
 * Same-origin requests send the auth (NextAuth session) cookie automatically,
 * which is why these streams work without the `X-Api-Secret` header that
 * `EventSource` cannot set.
 */
export function useEventStream<T>(
  url: string | null,
  onMessage: (data: T) => void,
): void {
  // Keep the latest handler in a ref so re-renders don't reopen the connection.
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    if (!url) return;

    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryMs = EVENT_STREAM_RETRY_MIN_MS;
    let stopped = false;

    const open = () => {
      if (stopped) return;
      // Never two at once: whatever is still around is closed first.
      source?.close();
      source = null;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const es = new EventSource(url, { withCredentials: true });
      source = es;
      es.onopen = () => {
        if (source !== es) return;
        retryMs = EVENT_STREAM_RETRY_MIN_MS;
      };
      es.onmessage = (event) => {
        if (!event.data) return;
        try {
          handlerRef.current(JSON.parse(event.data) as T);
        } catch {
          // Ignore malformed frames — the connection stays open.
        }
      };
      es.onerror = () => {
        // A late error from an instance already replaced is not ours to act on.
        if (stopped || source !== es) return;
        // CONNECTING: the browser is retrying by itself; leave it alone.
        if (es.readyState !== EventSource.CLOSED) return;
        es.close();
        source = null;
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          open();
        }, retryMs);
        retryMs = Math.min(retryMs * 2, EVENT_STREAM_RETRY_MAX_MS);
      };
    };
    open();

    return () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, [url]);
}
