/**
 * Client-side workspace resolution for PostHog telemetry.
 *
 * The active workspace is derived from the URL (`/w/<slug>/...`) at event time
 * rather than from a persisted super property, so telemetry can never lag a
 * workspace switch: both workspace switchers hard-navigate
 * (`window.location.assign`), and PostHog auto-captures a `$pageview` the
 * instant `posthog.init` runs on the new page — before React hydrates. A super
 * property set in a React effect is registered too late for that pageview and,
 * because it persists in localStorage, the stale previous-workspace value is
 * what the pageview carries. Reading the live URL in `before_send` closes that
 * gap entirely.
 *
 * The URL only carries the slug, but the canonical key (matching the server
 * side and PostHog group analytics) is the workspace UUID. We bridge the two
 * with a small slug -> id map persisted here: `PostHogWorkspaceTracker` writes
 * every membership the session knows about (so a workspace the user has never
 * visited is still resolvable the first time they switch into it), and
 * `before_send` reads it synchronously.
 */

const WORKSPACE_MAP_STORAGE_KEY = 'mnab.posthog.workspaceMap';

/** Extract the workspace slug from a `/w/<slug>/...` pathname, else null. */
export function workspaceSlugFromPath(pathname: string): string | null {
  const match = /^\/w\/([^/]+)/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Read the persisted slug -> workspaceId map. Never throws. */
export function readWorkspaceMap(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(WORKSPACE_MAP_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Merge `entries` into the persisted slug -> workspaceId map. Merging (rather
 * than replacing) keeps ids for workspaces resolved on earlier page loads even
 * if the current session's membership list is narrower. Never throws.
 */
export function rememberWorkspaces(entries: Record<string, string>): void {
  if (typeof window === 'undefined') return;
  try {
    const next = { ...readWorkspaceMap(), ...entries };
    window.localStorage.setItem(WORKSPACE_MAP_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable (private mode / quota) — telemetry falls back to
    // stamping the slug only, which is still correct, just without the UUID.
  }
}

/** Resolve a slug to its workspace UUID via the persisted map, else null. */
export function resolveWorkspaceId(slug: string): string | null {
  return readWorkspaceMap()[slug] ?? null;
}

/**
 * The workspace identity for a given pathname, as it should be stamped onto a
 * PostHog event. Returns null when the path is not workspace-scoped (e.g. the
 * `/workspace` picker), signalling that any workspace attribution should be
 * stripped rather than carried over from a persisted super property.
 */
export function workspaceIdentityForPath(
  pathname: string,
): { slug: string; id: string | null } | null {
  const slug = workspaceSlugFromPath(pathname);
  if (!slug) return null;
  return { slug, id: resolveWorkspaceId(slug) };
}
