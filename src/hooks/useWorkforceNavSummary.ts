"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getWorkspaceSlugFromUrl } from "@/lib/api/client";
import { getWorkforceNavSummary, type WorkforceNavSummary } from "@/lib/api/workforce";

const QUERY_ROOT = "workforce-nav-summary";

const EMPTY: WorkforceNavSummary = { unseen_failures: 0, queue: 0, running: 0 };

/**
 * The Workforce nav item's badges: the user's unseen failures (red), the
 * workspace's queue (yellow) and whether anything is running (blinking dot).
 * Shared through the react-query cache, so the expanded and icon-rail sidebars
 * (both mounted at once) issue a single request. Runs start and finish while
 * the user is elsewhere, so it refetches on focus and every 20 seconds.
 */
export function useWorkforceNavSummary(enabled = true): WorkforceNavSummary {
  const slug = getWorkspaceSlugFromUrl();
  const { data } = useQuery({
    queryKey: [QUERY_ROOT, slug],
    queryFn: getWorkforceNavSummary,
    enabled,
    staleTime: 10_000,
    refetchInterval: 20_000,
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
