"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getWorkspaceSlugFromUrl } from "@/lib/api/client";
import { getWorkforceNavSummary, type WorkforceNavSummary } from "@/lib/api/workforce";
import { useLiveRefetchInterval } from "@/components/live/LiveEventsProvider";
import { LIVE_TOPICS } from "@/lib/live/topics";

/** Keyed under the `workforce` live topic: `GET /api/events` invalidates it on every queue write. */
const QUERY_ROOT = LIVE_TOPICS.workforce;
const QUERY_NAME = "nav-summary";

const EMPTY: WorkforceNavSummary = { unseen_failures: 0, queue: 0, running: 0 };

/** The polling cadence while the live stream is down. */
const FALLBACK_POLL_MS = 5_000;

/**
 * The Workforce nav item's badges: the workspace's unseen failures (red cross)
 * and its queue (yellow, blinking while work is in it). Shared through the
 * react-query cache, so the expanded and icon-rail sidebars (both mounted at
 * once) issue a single request. Runs start, finish and fail while the user is
 * elsewhere: the live stream invalidates the query as they do, and it refetches
 * on focus and on a slow interval (every few seconds only while the stream is
 * down).
 */
export function useWorkforceNavSummary(enabled = true): WorkforceNavSummary {
  const slug = getWorkspaceSlugFromUrl();
  const refetchInterval = useLiveRefetchInterval(FALLBACK_POLL_MS);
  const { data } = useQuery({
    queryKey: [QUERY_ROOT, slug, QUERY_NAME],
    queryFn: getWorkforceNavSummary,
    enabled,
    staleTime: FALLBACK_POLL_MS - 1_000,
    refetchInterval,
  });
  return enabled ? (data ?? EMPTY) : EMPTY;
}

/**
 * Refetch the badges now — e.g. after the user opens a failed task, which
 * clears it from their unseen count, so the red chip doesn't wait for a poll.
 */
export function useRefreshWorkforceNavSummary(): () => void {
  const queryClient = useQueryClient();
  return useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [QUERY_ROOT, getWorkspaceSlugFromUrl(), QUERY_NAME] });
  }, [queryClient]);
}
