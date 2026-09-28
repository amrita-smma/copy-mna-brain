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
  getPostHogClient()?.capture({
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
  getPostHogClient()?.capture({
    distinctId: args.distinctId,
    event: args.event,
    properties: args.properties,
  });
}

export async function shutdownPostHog() {
  if (posthogClient) {
    await posthogClient.shutdown();
  }
}
