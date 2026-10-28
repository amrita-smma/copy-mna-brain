import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { createDb } from '@/lib/server/db';
import { getActiveWorkspaceId } from '@/lib/workspace';
import { createContainer } from '@/lib/services/container';
import { createRedisSubscriber, redisConfigured } from '@/lib/server/redis';
import { encodeSseComment, encodeSseEvent, SSE_HEADERS } from '@/lib/server/sse';
import { readPresence, userChannel, workspaceChannel } from '@/lib/bots/presence';
import { isBotLiveEvent, type BotLiveEvent, type BotPresence } from '@/lib/bots/presenceTypes';

/** Long enough for a stream; `EventSource` reconnects when the server closes it. */
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

/** Below `maxDuration`, like the other SSE routes (`src/lib/server/sse.ts`). */
export const STREAM_LIFETIME_MS = 240_000;
/**
 * How often the live keys are re-read while subscribed. A crashed turn's
 * presence expires in Redis without a message, and this is what tells the
 * client; otherwise the tick is a heartbeat comment.
 */
export const RECONCILE_MS = 10_000;

/**
 * The bots' live state, pushed: a `snapshot` (the bot list as `GET /api/bots`
 * returns it, plus who is thinking) on connect,
 * then every event the user's and the workspace's Redis channels carry
 * (`@/lib/bots/presence`). The snapshot is authoritative — a reconnect heals
 * anything missed — and the events are the fast path. Session-authed by
 * `proxy.ts`; `EventSource` sends the cookie.
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
    const userId = session.user.id;
    const workspaceId = await getActiveWorkspaceId();
    const { botService } = createContainer(createDb(), workspaceId);

    const encoder = new TextEncoder();
    const subscriber = createRedisSubscriber();
    let closed = false;
    let reconcile: ReturnType<typeof setInterval> | undefined;
    let lifetime: ReturnType<typeof setTimeout> | undefined;
    // What the client was last told, so a tick emits only changes.
    let chats: { chatId: string; botId: string }[] = [];
    let lastPresence = new Map<string, BotPresence>();

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
        const emit = (event: BotLiveEvent) => send(encodeSseEvent(event));
        // Ends the response FIRST, then drops the socket without a QUIT round
        // trip: on a half-open connection `quit()` waits for a reply that never
        // comes, and a close that awaited it left the response open until the
        // platform killed the function at `maxDuration`.
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(reconcile);
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

        const snapshot = async () => {
          const bots = await botService.list(userId);
          chats = bots.flatMap((b) => (b.thread_id ? [{ chatId: b.thread_id, botId: b.id }] : []));
          const chatIds = chats.map((c) => c.chatId);
          lastPresence = await readPresence(chatIds);
          emit({ type: 'snapshot', bots, presence: [...lastPresence.values()] });
        };

        // Expired or changed keys since the last tick, as the events the
        // channel would have carried.
        const tick = async () => {
          const chatIds = chats.map((c) => c.chatId);
          const presence = await readPresence(chatIds);
          let emitted = false;
          for (const { chatId, botId } of chats) {
            const before = lastPresence.get(chatId);
            const now = presence.get(chatId);
            if ((before?.phase ?? null) !== (now?.phase ?? null) || before?.turnId !== now?.turnId) {
              emit({ type: 'presence', chatId, botId, turnId: now?.turnId ?? before?.turnId ?? '', phase: now?.phase ?? null });
              emitted = true;
            }
          }
          lastPresence = presence;
          if (!emitted) send(encodeSseComment('hb'));
        };

        try {
          subscriber.on('message', (_channel: string, message: string) => {
            let event: unknown;
            try {
              event = JSON.parse(message);
            } catch {
              return;
            }
            if (!isBotLiveEvent(event)) return;
            // Keep the tick's picture current so it does not re-announce.
            if (event.type === 'presence') {
              if (event.phase === null) lastPresence.delete(event.chatId);
              else {
                lastPresence.set(event.chatId, {
                  chatId: event.chatId,
                  botId: event.botId,
                  userId,
                  phase: event.phase,
                  since: new Date().toISOString(),
                  turnId: event.turnId,
                });
              }
            }
            emit(event);
            // A new bot means a new thread to watch: re-read the list.
            if (event.type === 'bots-changed') void snapshot().catch(() => undefined);
          });
          subscriber.on('error', close);
          await subscriber.subscribe(userChannel(workspaceId, userId), workspaceChannel(workspaceId));
          await snapshot();
        } catch (err) {
          console.error('[bots/events] failed to start the stream:', err);
          close();
          return;
        }

        // Closed while starting (the lifetime cap, an abort, a Redis error):
        // arming the timer now would keep a dead stream's function alive.
        if (closed) return;
        reconcile = setInterval(() => void tick().catch(() => send(encodeSseComment('err'))), RECONCILE_MS);
      },
      cancel() {
        closed = true;
        clearInterval(reconcile);
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
