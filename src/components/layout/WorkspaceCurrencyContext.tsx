'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { DEFAULT_CURRENCY, type Currency } from '@/lib/currency';

// Carries the workspace's display currency to every client view. Set once by
// the /w/[workspaceSlug] layout from workspaces.default_currency; views read it
// via useWorkspaceCurrency() to relabel money formatting (no FX conversion).
const WorkspaceCurrencyContext = createContext<Currency>(DEFAULT_CURRENCY);

export function WorkspaceCurrencyProvider({
  currency,
  children,
}: {
  currency: Currency;
  children: ReactNode;
}) {
  return (
    <WorkspaceCurrencyContext.Provider value={currency}>
      {children}
    </WorkspaceCurrencyContext.Provider>
  );
}

export function useWorkspaceCurrency(): Currency {
  return useContext(WorkspaceCurrencyContext);
}
