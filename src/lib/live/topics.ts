/**
 * The workspace live-updates stream, as both sides see it (client safe).
 *
 * A *topic* names a kind of server state a view keeps on screen while it is
 * changing elsewhere — a screening finishing, a workforce run starting, an AI
 * Opinion verdict landing, a deal arriving in Sourcing. A service that writes
 * such state publishes `{ topic, ids? }` after its write (`publishLiveEvent`,
 * `@/lib/server/liveEvents`); `GET /api/events` forwards it to every open tab
 * of the workspace; `LiveEventsProvider` turns it into
 * `queryClient.invalidateQueries({ queryKey: [topic] })`.
 *
 * So the contract for a live view is: its react-query key starts with the
 * topic (`[LIVE_TOPICS.screenings, slug, companyId]`), and it keeps a slow
 * `refetchInterval` as the fallback for when the stream is down.
 */
export const LIVE_TOPICS = {
  /** `screenings` rows: state / result changes. */
  screenings: 'screenings',
  /** `ai_workforce_queue` rows: queued, started, paused, finished, failed, seen, reordered. */
  workforce: 'workforce',
  /** `companies.ai_opinion_status`: a run started, finished or failed. */
  aiOpinion: 'ai-opinion',
  /** Sourcing's Pending Confirmation bucket: a company arrived, left, or was dropped. */
  sourcing: 'sourcing',
} as const;

export type LiveTopic = (typeof LIVE_TOPICS)[keyof typeof LIVE_TOPICS];

export const ALL_LIVE_TOPICS: readonly LiveTopic[] = Object.values(LIVE_TOPICS);

/** Everything the stream sends. */
export type LiveEvent =
  /** Server state of `topic` changed; `ids` names the rows when the writer knows them. */
  | { type: 'invalidate'; topic: LiveTopic; ids?: string[] }
  /**
   * Sent once per connection, on open. Pub/sub does not replay, so a client
   * that (re)connects refetches every live query to pick up what it missed.
   */
  | { type: 'resync' };

export function isLiveTopic(value: unknown): value is LiveTopic {
  return typeof value === 'string' && (ALL_LIVE_TOPICS as readonly string[]).includes(value);
}

export function isLiveEvent(value: unknown): value is LiveEvent {
  if (typeof value !== 'object' || value === null) return false;
  const { type, topic, ids } = value as { type?: unknown; topic?: unknown; ids?: unknown };
  if (type === 'resync') return true;
  if (type !== 'invalidate' || !isLiveTopic(topic)) return false;
  return ids === undefined || (Array.isArray(ids) && ids.every((id) => typeof id === 'string'));
}
