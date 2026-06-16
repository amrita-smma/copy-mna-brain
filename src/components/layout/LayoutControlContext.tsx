'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from 'react';
import { useSidebar } from '@/components/ui/sidebar';

interface LayoutControlValue {
  /**
   * Bring the AI copilot into focus: reveal the copilot pane and collapse the
   * left-side navigation. Wired to every "Analyze using AI" trigger via
   * AskAIButton so analyzing always lands the user in a copilot-focused layout.
   */
  focusCopilot: () => void;
}

const LayoutControlContext = createContext<LayoutControlValue | null>(null);

/**
 * Provides layout controls to the dashboard's main content. Must be rendered
 * INSIDE `SidebarProvider` (it calls `useSidebar`). The copilot pane's
 * visibility lives one level up in DashboardLayout, so revealing it is passed
 * in via `revealCopilot`.
 */
export function LayoutControlProvider({
  revealCopilot,
  children,
}: {
  revealCopilot: () => void;
  children: ReactNode;
}) {
  const { setOpen } = useSidebar();

  const focusCopilot = useCallback(() => {
    revealCopilot();
    setOpen(false);
  }, [revealCopilot, setOpen]);

  const value = useMemo<LayoutControlValue>(
    () => ({ focusCopilot }),
    [focusCopilot],
  );

  return (
    <LayoutControlContext.Provider value={value}>
      {children}
    </LayoutControlContext.Provider>
  );
}

const NOOP: LayoutControlValue = { focusCopilot: () => {} };

/**
 * Layout controls for the surrounding dashboard. Returns no-ops when used
 * outside `LayoutControlProvider` so shared components (e.g. AskAIButton) can
 * call it unconditionally without crashing in non-dashboard contexts.
 */
export function useLayoutControl(): LayoutControlValue {
  return useContext(LayoutControlContext) ?? NOOP;
}
