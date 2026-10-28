import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createRedisSubscriber, redisConfigured } from '@/lib/server/redis';
import { encodeSseComment, encodeSseEvent, SSE_HEADERS } from '@/lib/server/sse';
import { liveEventsChannel } from '@/lib/server/liveEvents';
import { isLiveEvent, type LiveEvent } from '@/lib/live/topics';

/** Long enough for a stream; `EventSource` reconnects when the server closes it. */
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/** Below `maxDuration`, like `GET /api/bots/events`. */
export const STREAM_LIFETIME_MS = 240_000;
/** Idle cadence of the keep-alive comment, so proxies keep the connection open. */
export const HEARTBEAT_MS = 15_000;

/**
 * The workspace's live-updates stream: one connection per tab, no query
 * params, so it is opened once by `LiveEventsProvider` in the app shell and
 * never reopened on navigation. It is pure push — a subscription to the Redis
 * channel every live-state writer publishes to (`@/lib/server/liveEvents`) —
 * and touches no database: the clients refetch what an event names.
 *
 * Opens with a `resync` frame, because pub/sub does not replay: a client
 * refetches every live query on (re)connect and misses nothing. Session-authed
 * by `proxy.ts`; `EventSource` sends the cookie. Without Redis it answers 503
 * and the clients stay on their slow polling fallback.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (!redisConfigured()) {
      return NextResponse.json({ error: 'Live updates unavailable: Redis is not configured' }, { status: 503 });
    }
    const workspaceId = await getActiveWorkspaceId();

    const encoder = new TextEncoder();
    const subscriber = createRedisSubscriber();
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let lifetime: ReturnType<typeof setTimeout> | undefined;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            // The client went away between the check and the write.
          }
        };
        const emit = (event: LiveEvent) => send(encodeSseEvent(event));
        // Ends the response FIRST, then drops the socket without a QUIT round
        // trip: on a half-open connection `quit()` waits for a reply that never
        // comes, and a close that awaited it left the response open until the
        // platform killed the function at `maxDuration`.
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          clearTimeout(lifetime);
          try {
            controller.close();
          } catch {
            // Already closed.
          }
          subscriber.disconnect();
        };
        // Armed before anything is awaited, so a SUBSCRIBE or a first read that
        // hangs still ends the stream before `maxDuration`.
        lifetime = setTimeout(close, STREAM_LIFETIME_MS);
        req.signal.addEventListener('abort', close, { once: true });

        try {
          subscriber.on('message', (_channel: string, message: string) => {
            let event: unknown;
            try {
              event = JSON.parse(message);
            } catch {
              return;
            }
            if (!isLiveEvent(event)) return;
            emit(event);
          });
          subscriber.on('error', close);
          await subscriber.subscribe(liveEventsChannel(workspaceId));
          emit({ type: 'resync' });
        } catch (err) {
          console.error('[events] failed to start the stream:', err);
          close();
          return;
        }

        // Closed while starting (the lifetime cap, an abort, a Redis error):
        // arming the timer now would keep a dead stream's function alive.
        if (closed) return;
        heartbeat = setInterval(() => send(encodeSseComment('hb')), HEARTBEAT_MS);
      },
      cancel() {
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(lifetime);
        subscriber.disconnect();
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
