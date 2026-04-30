'use client';

import { createContext, useContext, ReactNode } from 'react';

export interface FeatureFlags {
  aiWorkforceEnabled: boolean;
}

const defaultFlags: FeatureFlags = {
  aiWorkforceEnabled: false,
};

const FeatureFlagsContext = createContext<FeatureFlags>(defaultFlags);

interface FeatureFlagsProviderProps {
  children: ReactNode;
  flags: FeatureFlags;
}

export function FeatureFlagsProvider({ children, flags }: FeatureFlagsProviderProps) {
  return (
    <FeatureFlagsContext.Provider value={flags}>
      {children}
    </FeatureFlagsContext.Provider>
  );
}

export function useFeatureFlags(): FeatureFlags {
  return useContext(FeatureFlagsContext);
}
