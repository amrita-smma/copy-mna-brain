/**
 * Publish-on-write for the workspace live-updates stream (`GET /api/events`).
 *
 * A service that changes state a view keeps live calls `publishLiveEvent`
 * after its write commits; the message goes to the Redis channel
 * `ws:<workspaceId>:events` and every open tab of the workspace invalidates
 * the matching react-query key (`@/lib/live/topics` has the contract).
 *
 * Best-effort, like `@/lib/bots/presence`: a Redis failure, or no `REDIS_URL`
 * at all, is logged once per kind and otherwise ignored — the view falls back
 * to its slow `refetchInterval`. Nothing here may fail a write.
 */
import type Redis from 'ioredis';
import { getRedis, RedisNotConfiguredError } from '@/lib/server/redis';
import type { LiveEvent, LiveTopic } from '@/lib/live/topics';

/** The subset of ioredis this module uses; tests pass an in-memory double. */
export type LiveEventsRedis = Pick<Redis, 'publish'>;

export const liveEventsChannel = (workspaceId: string) => `ws:${workspaceId}:events`;

const warned = new Set<string>();

/** The process client, or null (logged once) when Redis is not configured. */
function clientOrNull(): LiveEventsRedis | null {
  try {
    return getRedis();
  } catch (err) {
    if (err instanceof RedisNotConfiguredError) {
      if (!warned.has('configured')) {
        warned.add('configured');
        console.error(`[redis] ${err.message} Live updates fall back to polling.`);
      }
      return null;
    }
    throw err;
  }
}

/**
 * Tell the workspace's open tabs that `topic` changed. `ids` names the rows
 * when the writer knows them; clients that care filter on it. Resolves once
 * the publish is acknowledged or has failed; callers that must not wait can
 * `void` it.
 */
export async function publishLiveEvent(
  workspaceId: string,
  topic: LiveTopic,
  ids?: readonly string[],
  redis: LiveEventsRedis | null = clientOrNull(),
): Promise<void> {
  if (!redis) return;
  const event: LiveEvent = ids && ids.length > 0 ? { type: 'invalidate', topic, ids: [...ids] } : { type: 'invalidate', topic };
  try {
    await redis.publish(liveEventsChannel(workspaceId), JSON.stringify(event));
  } catch (err) {
    const key = `publish ${topic}`;
    if (!warned.has(key)) {
      warned.add(key);
      console.error(`[redis] live event ${key} failed (further failures of this kind are not logged):`, err);
    }
  }
}
