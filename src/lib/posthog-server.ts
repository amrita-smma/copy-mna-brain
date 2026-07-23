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
 */
export function captureWorkspaceEvent(args: {
  workspaceId: string;
  distinctId: string;
  event: string;
  properties?: Record<string, unknown>;
}): void {
  getPostHogClient()?.capture({
    distinctId: args.distinctId,
    event: args.event,
    properties: {
      ...args.properties,
      workspace_id: args.workspaceId,
    },
    groups: { workspace: args.workspaceId },
  });
}

export async function shutdownPostHog() {
  if (posthogClient) {
    await posthogClient.shutdown();
  }
}
