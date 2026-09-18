/**
 * The `before_send` transform for client-side PostHog capture.
 *
 * Lives here rather than inline in `src/instrumentation-client.ts` so it can be
 * unit tested — `instrumentation-client.ts` runs `posthog.init` as a module
 * side effect and can't be imported from a test.
 *
 * Two jobs:
 *  1. Drop ordinary telemetry captured on the unauthenticated pages, while
 *     letting *identity* events through (see `IDENTITY_EVENTS`).
 *  2. Stamp the active workspace onto every surviving event, derived from the
 *     live URL (see `@/lib/posthog-workspace` for why it's the URL and not a
 *     persisted super property).
 */

import type { CaptureResult } from 'posthog-js';
import { workspaceIdentityForPath } from '@/lib/posthog-workspace';

/** Pages a logged-out visitor can reach. Their telemetry isn't interesting. */
export const UNAUTHENTICATED_PATHS = ['/login', '/reset-password'];

/**
 * Events that establish *who* the user is rather than *what they did*.
 *
 * These must never be dropped by the unauthenticated-path filter below.
 * `posthog.identify()` is implemented as `capture('$identify', ...)`, so a
 * blanket path filter silently swallows it — and with it both the anonymous ->
 * identified merge and the `$set` person properties it carries (`email`,
 * `name`). The symptom is events that arrive in PostHog under a person with no
 * searchable properties, which reads exactly like "this user's telemetry is
 * missing". `person_profiles` defaults to `identified_only`, so a user whose
 * `$identify` never lands may get no person profile at all.
 */
export const IDENTITY_EVENTS: ReadonlySet<string> = new Set([
  '$identify',
  '$set',
  '$create_alias',
  '$groupidentify',
]);

/** Whether `pathname` is one of the unauthenticated pages (or a subpath of one). */
export function isUnauthenticatedPath(pathname: string): boolean {
  return UNAUTHENTICATED_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

/**
 * Whether an event captured on `pathname` should be discarded.
 * Identity events survive everywhere; everything else is dropped on the
 * unauthenticated pages.
 */
export function shouldDropEvent(eventName: string, pathname: string): boolean {
  if (IDENTITY_EVENTS.has(eventName)) return false;
  return isUnauthenticatedPath(pathname);
}

/**
 * Stamp `event` with the workspace implied by `pathname`, mutating it in place.
 *
 * Runs synchronously at capture time — including for PostHog's own
 * auto-captured `$pageview` on page load — so a workspace switch (a hard
 * navigation) can never leave an event attributed to the previous workspace.
 */
export function applyWorkspaceIdentity(event: CaptureResult, pathname: string): void {
  const props = (event.properties ??= {});
  const identity = workspaceIdentityForPath(pathname);

  if (!identity) {
    // Not a workspace-scoped route (e.g. the workspace picker) — strip any
    // workspace attribution so these events aren't misfiled.
    delete props.workspace_slug;
    delete props.workspace_id;
    if (props.$groups) delete props.$groups.workspace;
    return;
  }

  props.workspace_slug = identity.slug;
  if (identity.id) {
    props.workspace_id = identity.id;
    props.$groups = { ...(props.$groups ?? {}), workspace: identity.id };
  } else {
    // Slug known but UUID not resolved yet (very first load before the map is
    // populated) — never carry a stale id from a persisted super property.
    delete props.workspace_id;
    if (props.$groups) delete props.$groups.workspace;
  }
}

/**
 * `before_send` body: returns the event to send, or null to drop it.
 * `pathname` is the page the event was captured on.
 */
export function transformEvent(
  event: CaptureResult | null,
  pathname: string,
): CaptureResult | null {
  if (!event) return event;
  if (shouldDropEvent(event.event, pathname)) return null;
  applyWorkspaceIdentity(event, pathname);
  return event;
}
