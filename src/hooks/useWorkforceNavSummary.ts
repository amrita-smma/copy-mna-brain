"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getWorkspaceSlugFromUrl } from "@/lib/api/client";
import { getWorkforceNavSummary, type WorkforceNavSummary } from "@/lib/api/workforce";

const QUERY_ROOT = "workforce-nav-summary";

const EMPTY: WorkforceNavSummary = { unseen_failures: 0, queue: 0, running: 0 };

/** How often the chip re-reads the queue while the app is open. */
const POLL_MS = 5_000;

/**
 * The Workforce nav item's badges: the workspace's unseen failures (red cross)
 * and its queue (yellow, blinking while work is in it). Shared through the
 * react-query cache, so the expanded and icon-rail sidebars (both mounted at
 * once) issue a single request. Runs start, finish and fail while the user is
 * elsewhere, so it refetches on focus and every few seconds — the same cadence
 * the task view polls at, so the chip tracks what the page would show.
 */
export function useWorkforceNavSummary(enabled = true): WorkforceNavSummary {
  const slug = getWorkspaceSlugFromUrl();
  const { data } = useQuery({
    queryKey: [QUERY_ROOT, slug],
    queryFn: getWorkforceNavSummary,
    enabled,
    staleTime: POLL_MS - 1_000,
    refetchInterval: POLL_MS,
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
    void queryClient.invalidateQueries({ queryKey: [QUERY_ROOT] });
  }, [queryClient]);
}
