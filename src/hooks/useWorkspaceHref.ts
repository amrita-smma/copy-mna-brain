'use client';

import { useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';

/**
 * Prefixes an internal path with the current tab's own workspace slug, e.g.
 * `useWorkspaceHref('/pipeline')` -> `/w/togan-vcc/pipeline`. Use this (or
 * `<WorkspaceLink>`) for every internal navigation to a workspace-scoped
 * route instead of hardcoding a flat path — flat paths 404 now that those
 * routes live under `/w/[workspaceSlug]/...`.
 */
export function useWorkspaceHref(path: string): string {
  const params = useParams<{ workspaceSlug?: string }>();
  return buildWorkspaceHref(params.workspaceSlug, path, 'useWorkspaceHref');
}

/**
 * The same prefixing as {@link useWorkspaceHref}, but as a function you can
 * call later with a path you don't know at render time — e.g. pushing to
 * whichever page the copilot's `navigate_page` tool picked.
 *
 * Prefer `<WorkspaceLink>` or `useWorkspaceHref` for anything the user clicks;
 * this is for programmatic navigation only.
 */
export function useWorkspacePush(): (path: string) => void {
  const router = useRouter();
  const params = useParams<{ workspaceSlug?: string }>();
  const workspaceSlug = params.workspaceSlug;
  return useCallback(
    (path: string) => {
      router.push(buildWorkspaceHref(workspaceSlug, path, 'useWorkspacePush'));
    },
    [router, workspaceSlug],
  );
}

function buildWorkspaceHref(
  workspaceSlug: string | undefined,
  path: string,
  caller: string,
): string {
  if (!workspaceSlug) {
    // Warn in every environment, not just dev — a literal "/w/undefined/..."
    // href is a silent broken link in production with nothing to catch it.
    // eslint-disable-next-line no-console
    console.warn(
      `${caller}("${path}") called outside a /w/[workspaceSlug]/ route — falling back to the workspace picker instead of a broken "/w/undefined${path}" link.`,
    );
    return '/workspace';
  }
  // `'/'` means the workspace root. Appending it verbatim would produce
  // `/w/<slug>/`, which Next then 308-redirects to `/w/<slug>` — a wasted
  // round-trip (through the proxy, twice) on every link to the chat landing.
  if (path === '/' || path === '') return `/w/${workspaceSlug}`;
  return `/w/${workspaceSlug}${path}`;
}
