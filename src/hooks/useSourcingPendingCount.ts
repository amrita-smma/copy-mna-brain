"use client";

import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getWorkspaceSlugFromUrl } from "@/lib/api/client";
import { getCompaniesCount } from "@/lib/api/pipeline";
import { UNREVIEWED_STAGE } from "@/lib/constants";

const QUERY_ROOT = "sourcing-pending-count";

/**
 * How many deals sit in Sourcing's Pending Confirmation bucket — active
 * companies of any source at the `unreviewed` stage, the same rows Pipeline counts
 * for its own chip. Shared through the react-query cache, so the expanded and
 * icon-rail sidebars (both mounted at once) issue a single request.
 *
 * Inbound ingest lands new pending deals while the user is on other pages, so
 * the count also refetches on window focus and once a minute.
 */
export function useSourcingPendingCount(enabled = true): number {
  const slug = getWorkspaceSlugFromUrl();
  const { data } = useQuery({
    queryKey: [QUERY_ROOT, slug],
    queryFn: () =>
      getCompaniesCount({
        stage: UNREVIEWED_STAGE,
        excludeDropped: true,
      }),
    enabled,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  return enabled ? (data ?? 0) : 0;
}

/**
 * Lets a view that already holds the full company list (Pipeline / Sourcing)
 * push its own pending count into the cache, so the sidebar badge follows a
 * triage, promote or drop immediately instead of on the next poll.
 */
export function usePublishSourcingPendingCount(): (count: number) => void {
  const queryClient = useQueryClient();
  return useCallback(
    (count: number) => {
      queryClient.setQueryData([QUERY_ROOT, getWorkspaceSlugFromUrl()], count);
    },
    [queryClient],
  );
}
