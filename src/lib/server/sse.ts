/**
 * Server-Sent Events (SSE) helpers.
 *
 * `changeStream` turns a periodic server-side snapshot into an SSE
 * `ReadableStream`: it calls `snapshot()` on an interval and only emits a
 * `data:` event when the snapshot's `signature` changes, so a single long-lived
 * connection replaces many short client polling requests. Idle ticks send a
 * heartbeat comment to keep the connection open through proxies. The stream
 * ends when the request aborts or `maxDurationMs` elapses — the browser's
 * `EventSource` then reconnects on its own.
 */

const encoder = new TextEncoder();

/** Encode a payload as an SSE `data:` event (with an optional `event:` name). */
export function encodeSseEvent(data: unknown, event?: string): string {
  const lines: string[] = [];
  if (event) lines.push(`event: ${event}`);
  lines.push(`data: ${JSON.stringify(data)}`);
  return `${lines.join('\n')}\n\n`;
}

/** Encode an SSE comment line. Comments are ignored by `EventSource`; used as a keep-alive heartbeat. */
export function encodeSseComment(text: string): string {
  return `: ${text}\n\n`;
}

export interface ChangeStreamOptions<T> {
  /** Fetch the current snapshot. Called once per tick. */
  snapshot: () => Promise<T>;
  /** Stable string identity of a snapshot; a change triggers an emit. Defaults to `JSON.stringify`. */
  signature?: (snapshot: T) => string;
  /** Aborted when the client disconnects (pass `req.signal`). */
  signal?: AbortSignal;
  /** Server-side poll cadence in ms. Default 3000. */
  intervalMs?: number;
  /** Hard cap on connection lifetime in ms. Default 240_000 (below the 300s function limit). */
  maxDurationMs?: number;
  /** Injectable clock/sleep — overridden in tests. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Async generator of SSE-encoded chunks. Yields the initial snapshot as a
 * `data:` event, then one chunk per tick: a `data:` event when the signature
 * changed, otherwise a heartbeat comment. A failed `snapshot()` yields an error
 * comment and keeps the connection alive (transient DB hiccups shouldn't drop it).
 */
export async function* changeEvents<T>(opts: ChangeStreamOptions<T>): AsyncGenerator<string> {
  const {
    snapshot,
    signature = (s) => JSON.stringify(s),
    signal,
    intervalMs = 3000,
    maxDurationMs = 240_000,
    now = () => Date.now(),
    sleep = defaultSleep,
  } = opts;

  const start = now();
  let lastSig: string | undefined;

  while (!signal?.aborted && now() - start < maxDurationMs) {
    let chunk: string;
    try {
      const snap = await snapshot();
      const sig = signature(snap);
      if (sig !== lastSig) {
        lastSig = sig;
        chunk = encodeSseEvent(snap);
      } else {
        chunk = encodeSseComment('hb');
      }
    } catch {
      chunk = encodeSseComment('err');
    }
    yield chunk;
    await sleep(intervalMs, signal);
  }
}

/** Wrap `changeEvents` in a `ReadableStream<Uint8Array>` suitable for an SSE `Response`. */
export function changeStream<T>(opts: ChangeStreamOptions<T>): ReadableStream<Uint8Array> {
  const iterator = changeEvents(opts);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(value));
    },
    async cancel() {
      await iterator.return?.(undefined);
    },
  });
}

/** Standard headers for an SSE response. */
export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
} as const;
