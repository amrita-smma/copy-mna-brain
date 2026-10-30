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
 * `refetchInterval` as the fallback for when the stream is down. Nothing in
 * the client watches server state on its own timer: see
 * `.claude/rules/live-updates.md`.
 */
export const LIVE_TOPICS = {
  /** `screenings` rows: state / result changes. */
  screenings: 'screenings',
  /** `ai_workforce_queue` rows: queued, started, paused, finished, failed, seen, reordered. */
  workforce: 'workforce',
  /**
   * A running agent's checkpoint grew (a model reply or tool result was
   * persisted). Its own topic so only the trace canvases redraw, not every
   * view keyed under `workforce`. `ids` are run ids.
   */
  workforceTrace: 'workforce-trace',
  /** `companies.ai_opinion_status`: a run started, finished or failed. */
  aiOpinion: 'ai-opinion',
  /** Sourcing's Pending Confirmation bucket: a company arrived, left, or was dropped. */
  sourcing: 'sourcing',
  /** `deal_documents.processing_status`: an attachment's AI processing moved. `ids` are document ids. */
  documents: 'documents',
  /** `company_analyses` (the AI Company Card): a run wrote the row. `ids` are company ids. */
  companyCard: 'company-card',
  /** A contact search saved CRM contacts for a company. `ids` are company ids. */
  contacts: 'contacts',
  /** A company's voting round: started, a ballot saved, sent back, cancelled, concluded, synthesised. `ids` are company ids. */
  voting: 'voting',
  /** `jobs.status`: a job started or reached a terminal state. `ids` are job ids. */
  jobs: 'jobs',
  /** Smart Files (`files.processing_status`): a file landed, processed, failed, dropped or was approved. `ids` are file ids. */
  files: 'files',
  /** An insight gained a version (edit, refresh, rollback). `ids` are insight ids. */
  insights: 'insights',
  /** A user's personal tasks changed. `ids` are user ids. */
  userTasks: 'user-tasks',
  /** A CRM contact's relationship overview moved (pending, ready, failed). `ids` are correspondent ids. */
  crmOverview: 'crm-overview',
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
