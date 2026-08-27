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
  /**
   * Uncover the center console: dock the copilot and drop out of main's
   * full-screen mode. Wired to anything in the chat that sends the user to a
   * page — the "Opened X" navigation chip — since following such a link while
   * the copilot is expanded would otherwise navigate behind it, leaving the
   * user looking at the same chat and wondering whether the click registered.
   */
  revealConsole: () => void;
  /**
   * Put the copilot full-screen over the console. Wired to every "New chat"
   * trigger: starting a conversation should land the user in the conversation,
   * not leave a fresh empty chat cramped in a docked pane they then have to
   * expand by hand.
   */
  expandCopilot: () => void;
}

const LayoutControlContext = createContext<LayoutControlValue | null>(null);

/**
 * Provides layout controls to both the center console and the copilot pane.
 * Must be rendered INSIDE `SidebarProvider` (it calls `useSidebar`) and must
 * wrap BOTH panes — the console's children use `focusCopilot`, while the chat
 * inside the copilot pane uses `revealConsole`. The pane visibility state itself
 * lives one level up in AppShell, so both actions are passed in.
 */
export function LayoutControlProvider({
  revealCopilot,
  revealConsole,
  expandCopilot,
  children,
}: {
  revealCopilot: () => void;
  revealConsole: () => void;
  expandCopilot: () => void;
  children: ReactNode;
}) {
  const { setOpen } = useSidebar();

  const focusCopilot = useCallback(() => {
    revealCopilot();
    setOpen(false);
  }, [revealCopilot, setOpen]);

  const value = useMemo<LayoutControlValue>(
    () => ({ focusCopilot, revealConsole, expandCopilot }),
    [focusCopilot, revealConsole, expandCopilot],
  );

  return (
    <LayoutControlContext.Provider value={value}>
      {children}
    </LayoutControlContext.Provider>
  );
}

const NOOP: LayoutControlValue = {
  focusCopilot: () => {},
  revealConsole: () => {},
  expandCopilot: () => {},
};

/**
 * Layout controls for the surrounding dashboard. Returns no-ops when used
 * outside `LayoutControlProvider` so shared components (e.g. AskAIButton) can
 * call it unconditionally without crashing in non-dashboard contexts.
 */
export function useLayoutControl(): LayoutControlValue {
  return useContext(LayoutControlContext) ?? NOOP;
}
