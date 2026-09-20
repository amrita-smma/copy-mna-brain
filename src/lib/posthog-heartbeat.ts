/**
 * Server-side activity heartbeat — the blocker-proof usage tracker.
 *
 * Every other usage metric we have is captured in the browser, which means an
 * ad blocker deletes the user from the dataset entirely: they look identical to
 * someone who never logged in. `client_telemetry_blocked` tells us *that* a user
 * is dark but nothing about what they did. This closes that gap.
 *
 * It runs in `src/proxy.ts`, which already gates and decodes the session JWT
 * for every authenticated request, so it sees real usage — page navigations
 * under `/w/*` and every `/api/*` call — without any code running in the
 * browser. Nothing here is reachable by a blocker.
 *
 * ## Why buckets instead of one event per request
 *
 * A heartbeat per request would be enormous volume and would measure request
 * chattiness, not usage. Instead, time is sliced into fixed
 * `HEARTBEAT_INTERVAL_MS` windows and a user emits at most one heartbeat per
 * window *per instance*. The window index (`heartbeat_bucket`) is derived from
 * wall-clock time, not from process state, which is what makes the metric
 * correct despite the throttle being per-instance in-memory: several instances
 * serving the same user in one window each build a byte-identical event, so
 * `$insert_id` deduplicates them at ingest and `uniqExact(heartbeat_bucket)`
 * would collapse any that slipped through. Active time is then
 * `distinct buckets x interval` — no shared dedup infrastructure, and no
 * database round-trip on the request path.
 *
 * Note this measures *active* time (windows containing at least one request),
 * not wall-clock time-on-page. That is deliberate: the client-side
 * `$prev_pageview_duration` it replaces counts an idle background tab as usage.
 */

import { posthogUpstreams } from '@/lib/posthog-proxy';
import { personPropertiesFor, SEND_EMAIL_WITH_EVENTS } from '@/lib/posthog-identity';

/** Event name. Distinct from every client-captured event so queries can't mix them. */
export const HEARTBEAT_EVENT = 'user_activity_heartbeat';

/**
 * Width of one activity window. Five minutes is short enough that a session's
 * start and end are pinned to within five minutes, and long enough that a busy
 * user costs ~12 events/hour rather than one per click.
 */
export const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Paths that must never count as user activity, even when a valid session is
 * attached to the request.
 *
 * `/api/auth/` is the load-bearing entry: the NextAuth client polls
 * `/api/auth/session` on an interval and on every window focus. Counting it
 * would make an abandoned background tab register as active usage forever,
 * which is the exact flaw in the metric this replaces.
 */
export const NON_ACTIVITY_PREFIXES = [
  '/ingest',
  '/api/auth/',
  '/api/cron/',
  '/api/queues/',
];

/** Exact paths excluded for the same reason as {@link NON_ACTIVITY_PREFIXES}. */
export const NON_ACTIVITY_PATHS = new Set([
  '/api/healthcheck',
  // Automatic ad-blocker probe report, fired by page load rather than by the
  // user. The `/w/*` navigation that triggered it already counts.
  '/api/client-health',
]);

/** Whether a request to `pathname` represents real user activity. */
export function isActivityPath(pathname: string): boolean {
  if (NON_ACTIVITY_PATHS.has(pathname)) return false;
  return !NON_ACTIVITY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix),
  );
}

/**
 * The activity window `nowMs` falls in. Derived purely from wall-clock time so
 * that independent serverless instances agree on the number without sharing
 * state — see the module docstring.
 */
export function heartbeatBucket(
  nowMs: number,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): number {
  return Math.floor(nowMs / intervalMs);
}

/**
 * Per-instance record of which window each user has already been counted in.
 *
 * Best-effort by design: a cold start or a second instance re-emits, and that
 * is harmless because duplicates carry the same bucket. Its only job is to keep
 * a single warm instance from emitting on every request.
 */
export interface HeartbeatThrottle {
  seen: Map<string, number>;
}

/**
 * Cap on tracked users per instance. Bounds memory on an instance that has
 * served many users; overflow just means an extra duplicate heartbeat.
 */
export const MAX_TRACKED_USERS = 10_000;

export function createHeartbeatThrottle(): HeartbeatThrottle {
  return { seen: new Map() };
}

/**
 * Claim `bucket` for `userId`, returning whether this caller should emit.
 *
 * Returns false when this user has already been counted in this window by this
 * instance. Entries from older windows are dropped once the map grows past
 * {@link MAX_TRACKED_USERS}, so a long-lived instance can't leak memory.
 */
export function claimHeartbeat(
  throttle: HeartbeatThrottle,
  userId: string,
  bucket: number,
): boolean {
  if (throttle.seen.get(userId) === bucket) return false;

  if (throttle.seen.size >= MAX_TRACKED_USERS) {
    for (const [id, seenBucket] of throttle.seen) {
      if (seenBucket < bucket) throttle.seen.delete(id);
    }
    // Sweeping stale windows can free nothing at all — every entry may belong
    // to the *current* window if more than MAX_TRACKED_USERS distinct users
    // arrive inside one interval. Without this second pass the "cap" would let
    // the map grow without bound and re-walk it on every new user. Map iterates
    // in insertion order, so dropping from the front evicts least-recent first;
    // an evicted user simply emits one extra (idempotent) heartbeat.
    while (throttle.seen.size >= MAX_TRACKED_USERS) {
      const oldest = throttle.seen.keys().next();
      if (oldest.done) break;
      throttle.seen.delete(oldest.value);
    }
  }

  throttle.seen.set(userId, bucket);
  return true;
}

/**
 * The workspace UUID for `slug`, from the JWT-embedded membership list.
 *
 * Falls back to the session's active workspace when the slug isn't one of the
 * user's (a superadmin viewing another tenant, or a non-workspace route), and
 * to null when neither resolves — a heartbeat with no workspace is still a
 * valid usage signal, so this never blocks the capture.
 */
export function resolveWorkspaceId(
  slug: string | null | undefined,
  workspaces: { workspaceId: string; slug: string }[] | undefined,
  activeWorkspaceId: string | null | undefined,
): string | null {
  if (slug) {
    const match = workspaces?.find((w) => w.slug === slug);
    if (match) return match.workspaceId;
  }
  return activeWorkspaceId ?? null;
}

export interface HeartbeatContext {
  userId: string;
  email?: string | null;
  workspaceSlug?: string | null;
  workspaceId?: string | null;
  pathname: string;
  method: string;
  bucket: number;
}

/** A PostHog `/i/v0/e/` capture body. */
export interface HeartbeatPayload {
  api_key: string;
  event: string;
  distinct_id: string;
  properties: Record<string, unknown>;
  timestamp: string;
}

export interface HeartbeatPayloadOptions {
  intervalMs?: number;
  /** Injected so the switched-off path is testable before the flag flips. */
  sendEmail?: boolean;
}

/**
 * Build the capture body.
 *
 * Two details make a duplicate from a second instance collapse rather than
 * double-count, so that `count()` is as trustworthy as
 * `uniqExact(heartbeat_bucket)`:
 *
 *  - `$insert_id` is `<user>:<bucket>`, PostHog's deduplication key.
 *  - `timestamp` is the *start of the window*, not the moment of the request.
 *    PostHog dedupes on the tuple including timestamp, so two instances must
 *    agree on it exactly; derived from the bucket, they always do. The cost is
 *    that a heartbeat is stamped up to one interval before the request that
 *    triggered it, which is irrelevant at this metric's granularity.
 *
 * `$set` is included (when there's an email) so a permanently blocked user
 * still gets a searchable PostHog person profile — for those users no
 * `$identify` ever reaches PostHog, so without this they exist only as a bare
 * UUID. It is deliberately *not* gated on `SEND_EMAIL_WITH_EVENTS`: that flag
 * governs stamping email on every event, which is what the `email` property
 * below does, not the person properties `identify` would set anyway.
 */
export function heartbeatPayload(
  apiKey: string,
  ctx: HeartbeatContext,
  options: HeartbeatPayloadOptions = {},
): HeartbeatPayload {
  const intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  const sendEmail = options.sendEmail ?? SEND_EMAIL_WITH_EVENTS;
  const email = ctx.email?.trim();

  const properties: Record<string, unknown> = {
    path: ctx.pathname,
    method: ctx.method,
    // Carried explicitly rather than re-derived from `timestamp` at query time,
    // so a query never has to know the interval to group by window.
    heartbeat_bucket: ctx.bucket,
    heartbeat_interval_seconds: Math.round(intervalMs / 1000),
    source: 'proxy',
    $insert_id: `${ctx.userId}:${ctx.bucket}`,
  };

  // Mirrors the client-side `email` super property, and honours the same kill
  // switch — otherwise flipping `SEND_EMAIL_WITH_EVENTS` off would silently
  // leave the server still stamping email on every event.
  if (sendEmail && email) properties.email = email;

  if (ctx.workspaceSlug) properties.workspace_slug = ctx.workspaceSlug;
  if (ctx.workspaceId) {
    properties.workspace_id = ctx.workspaceId;
    properties.$groups = { workspace: ctx.workspaceId };
  }

  const personProperties = personPropertiesFor({
    id: ctx.userId,
    email: ctx.email,
  });
  if (Object.keys(personProperties).length > 0) {
    properties.$set = personProperties;
  }

  return {
    api_key: apiKey,
    event: HEARTBEAT_EVENT,
    distinct_id: ctx.userId,
    properties,
    timestamp: new Date(ctx.bucket * intervalMs).toISOString(),
  };
}

/** Capture path on the PostHog ingestion host. */
export const CAPTURE_PATH = '/i/v0/e/';

/**
 * Resolve the capture URL, or null when PostHog isn't configured.
 *
 * Deliberately the real PostHog host, not our own `/ingest` rewrite: this
 * request originates on the server, where there is no blocker to evade, and
 * routing it through our own proxy would bounce it back through middleware.
 */
export function captureUrl(host: string | undefined): string | null {
  const upstreams = posthogUpstreams(host);
  return upstreams ? `${upstreams.apiHost}${CAPTURE_PATH}` : null;
}

/**
 * POST a heartbeat. Never throws — telemetry must not be able to fail a user's
 * request, and the caller is on the critical request path.
 *
 * A bare `fetch` rather than `posthog-node`: the proxy runs per request with no
 * meaningful process lifetime to flush a buffered client against, so the
 * batching a client library exists to provide has nothing to batch. One
 * fire-and-forget POST of a single event is the whole requirement.
 */
export async function sendHeartbeat(
  url: string,
  payload: HeartbeatPayload,
  fetchImpl: typeof fetch,
): Promise<void> {
  try {
    await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Diagnostics only — nothing useful to do, and never user-facing.
  }
}
