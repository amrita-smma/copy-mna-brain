'use client';

import { useEffect } from 'react';
import posthog from 'posthog-js';
import { useAuth } from '@/hooks/useAuth';
import { rememberWorkspaces } from '@/lib/posthog-workspace';

/**
 * Keeps PostHog telemetry separable by workspace on the client.
 *
 * The per-event `workspace_id` / `workspace_slug` stamping and group
 * association happen in `before_send` (see `src/instrumentation-client.ts`),
 * driven off the URL so they can never lag a workspace switch. This component's
 * only jobs are the two things `before_send` can't do on its own:
 *
 *  1. Persist the session's slug -> workspaceId map so `before_send` can
 *     resolve the URL slug to the canonical UUID synchronously — including on
 *     the very first `$pageview` after a hard-navigation workspace switch,
 *     since every membership is written here while on any workspace.
 *  2. Register the `workspace` group's friendly properties (its slug) so
 *     PostHog Group Analytics shows a readable label instead of a bare UUID.
 *
 * It deliberately does NOT `posthog.register(...)` a `workspace_id` super
 * property — that persisted-then-overwritten-in-an-effect approach is exactly
 * what left the initial pageview attributed to the previous workspace.
 */
export default function PostHogWorkspaceTracker({
  workspaceId,
  workspaceSlug,
}: {
  workspaceId: string;
  workspaceSlug: string;
}) {
  const { user } = useAuth();
  // Serialize so the effect re-runs when the membership set actually changes,
  // not on every render's fresh array reference.
  const membershipsKey = JSON.stringify(user?.workspaces ?? []);

  useEffect(() => {
    const entries: Record<string, string> = { [workspaceSlug]: workspaceId };
    for (const m of user?.workspaces ?? []) {
      if (m.slug && m.workspaceId) entries[m.slug] = m.workspaceId;
    }
    rememberWorkspaces(entries);

    posthog.group('workspace', workspaceId, { slug: workspaceSlug });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, workspaceSlug, membershipsKey]);

  return null;
}
