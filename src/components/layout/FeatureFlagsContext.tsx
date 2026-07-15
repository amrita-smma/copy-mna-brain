'use client';

import { createContext, useContext, type ReactNode } from 'react';

/** Map of feature key → effective enabled state for the active workspace. */
export type FeatureFlagMap = Record<string, boolean>;

const FeatureFlagsContext = createContext<FeatureFlagMap>({});

/**
 * Provides the request's active-workspace feature-flag map (resolved server-side
 * in the workspace layout) to client components like `DashboardLayout`, which
 * use it to gate sidebar navigation without per-page prop threading.
 */
export function FeatureFlagsProvider({
  flags,
  children,
}: {
  flags: FeatureFlagMap;
  children: ReactNode;
}) {
  return <FeatureFlagsContext.Provider value={flags}>{children}</FeatureFlagsContext.Provider>;
}

export function useFeatureFlags(): FeatureFlagMap {
  return useContext(FeatureFlagsContext);
}

/**
 * Whether a feature is enabled for the active workspace. Unknown keys default to
 * `true` (visible) so a missing/unresolved flag never hides UI unexpectedly.
 */
export function useFeatureEnabled(key: string): boolean {
  const flags = useFeatureFlags();
  return flags[key] ?? true;
}
