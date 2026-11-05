import { after } from "next/server";
import { PostHog } from 'posthog-node';

let posthogClient: PostHog | null = null;

export function getPostHogClient(): PostHog | null {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return null;
  if (!posthogClient) {
    posthogClient = new PostHog(key, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
      // For serverless environments, flush immediately
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return posthogClient;
}

/**
 * Drain the client's queue, resolving once the events are actually delivered.
 *
 * `capture()` only *enqueues*; `flushAt: 1` then kicks off a background flush
 * whose promise nobody holds. On a serverless platform the instance is frozen
 * the moment the response is written, so that in-flight POST is simply never
 * finished — the event is lost. `flush()` chains onto any flush already in
 * progress, so this resolves only when the send has completed.
 *
 * Never rejects: telemetry must not be able to fail its caller's work.
 */
export function flushPostHog(): Promise<void> {
  const client = getPostHogClient();
  if (!client) return Promise.resolve();
  return client.flush().then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Keep a fire-and-forget telemetry promise alive past the response.
 *
 * This is the piece that makes `capture()` durable in production: without it
 * the platform may freeze the instance before the queued event leaves the
 * process. `waitUntil` is unavailable outside a Vercel request context (local
 * `next dev`, jobs, tests), where the event loop stays alive on its own — so a
 * throw there is expected and ignored.
 */
function keepAlive(promise: Promise<unknown>): void {
  try {
    after(() => promise);
  } catch {
    // Not running on Vercel — nothing to extend.
  }
}

/**
 * How long a caller that *awaits* delivery is willing to wait for it.
 *
 * `@posthog/core` bounds a flush only by `fetchRetryCount * requestTimeout`,
 * which is tens of seconds against an unreachable ingestion host — far too
 * long to hold a request open for a diagnostic event.
 */
export const FLUSH_WAIT_MS = 3_000;

/**
 * Await delivery, but give up waiting after `timeoutMs`.
 *
 * Giving up is only ever about *waiting*: the flush is registered with
 * `keepAlive` first, so it still runs to completion in the background. This is
 * for the caller that has nothing else to hide the flush behind and therefore
 * has to await it, but must not stall on a slow or unreachable PostHog.
 */
export function flushPostHogWithin(timeoutMs: number = FLUSH_WAIT_MS): Promise<void> {
  const flush = flushPostHog();
  keepAlive(flush);

  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void flush.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Capture a server-side event stamped with the workspace it belongs to.
 * Every server capture must go through this instead of calling
 * `getPostHogClient()?.capture(...)` directly, so telemetry stays separable
 * by workspace in PostHog: the workspace id is written both as a
 * `workspace_id` event property (filterable everywhere, no plan requirement)
 * and as a `workspace` group (enables PostHog Group Analytics dashboards
 * per workspace).
 *
 * Pass `workspaceSlug` whenever the caller already knows it (a request
 * handler can read it off the session's membership claims for free). It is
 * stamped as `workspace_slug`, matching what `applyWorkspaceIdentity` puts on
 * every *client* capture — without it a PostHog insight filtered on
 * `workspace_slug = acme` silently omits the server-side events, which is
 * exactly the half of the data an ad blocker cannot drop.
 */
export function captureWorkspaceEvent(args: {
  workspaceId: string;
  workspaceSlug?: string | null;
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}): void {
  const slug = args.workspaceSlug?.trim();
  const client = getPostHogClient();
  if (!client) return;

  client.capture({
    distinctId: args.distinctId,
    event: args.event,
    properties: {
      ...args.properties,
      workspace_id: args.workspaceId,
      // Omitted rather than sent as null when unknown: a null would show up as
      // a real value in a PostHog breakdown alongside the genuine slugs.
      ...(slug ? { workspace_slug: slug } : {}),
    },
    groups: { workspace: args.workspaceId },
  });
  keepAlive(flushPostHog());
}

/**
 * Capture a server-side event that isn't scoped to a workspace.
 *
 * Reserved for the handful of events that genuinely have no workspace —
 * principally `user_signed_in`, which fires before any workspace is chosen.
 * Anything happening inside a workspace must use `captureWorkspaceEvent`
 * instead, so it stays filterable and groupable per workspace.
 *
 * Server-side capture is also the only kind an ad blocker cannot intercept,
 * which is why the events that matter most for per-user attribution are
 * emitted here rather than from the browser.
 */
export function captureUserEvent(args: {
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}): void {
  const client = getPostHogClient();
  if (!client) return;

  client.capture({
    distinctId: args.distinctId,
    event: args.event,
    properties: args.properties,
  });
  keepAlive(flushPostHog());
}

export async function shutdownPostHog() {
  if (posthogClient) {
    await posthogClient.shutdown();
  }
}
