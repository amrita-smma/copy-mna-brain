import { useEffect, useRef } from 'react';

/**
 * Subscribe to a Server-Sent Events endpoint.
 *
 * Pass `url = null` to stay disconnected (e.g. while nothing is in flight) —
 * this is how callers gate the connection on/off cheaply. `onMessage` receives
 * each parsed `data:` payload; heartbeat comment frames are ignored by
 * `EventSource` and never reach it. The connection is torn down on unmount or
 * when `url` changes, and the browser reconnects automatically on transient
 * drops (including when the server closes the stream at its lifetime cap).
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

    const source = new EventSource(url, { withCredentials: true });
    source.onmessage = (event) => {
      if (!event.data) return;
      try {
        handlerRef.current(JSON.parse(event.data) as T);
      } catch {
        // Ignore malformed frames — the connection stays open.
      }
    };

    return () => source.close();
  }, [url]);
}
