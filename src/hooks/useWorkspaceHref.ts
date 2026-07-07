'use client';

import { useParams } from 'next/navigation';

/**
 * Prefixes an internal path with the current tab's own workspace slug, e.g.
 * `useWorkspaceHref('/pipeline')` -> `/w/togan-vcc/pipeline`. Use this (or
 * `<WorkspaceLink>`) for every internal navigation to a workspace-scoped
 * route instead of hardcoding a flat path — flat paths 404 now that those
 * routes live under `/w/[workspaceSlug]/...`.
 */
export function useWorkspaceHref(path: string): string {
  const params = useParams<{ workspaceSlug?: string }>();
  const workspaceSlug = params.workspaceSlug;
  if (!workspaceSlug) {
    // Warn in every environment, not just dev — a literal "/w/undefined/..."
    // href is a silent broken link in production with nothing to catch it.
    // eslint-disable-next-line no-console
    console.warn(
      `useWorkspaceHref("${path}") called outside a /w/[workspaceSlug]/ route — falling back to the workspace picker instead of a broken "/w/undefined${path}" link.`,
    );
    return '/workspace';
  }
  return `/w/${workspaceSlug}${path}`;
}
