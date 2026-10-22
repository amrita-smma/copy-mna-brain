'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { WorkspaceLink } from '@/components/WorkspaceLink';
import { LiquidGlassButton } from '@/components/ui/liquid-glass';
import { findTabByPath, toLogicalPath } from '@/lib/navigation/consoleTabs';
import { useVisualViewport } from '@/hooks/use-visual-viewport';

/** Mobile names for the pages pinned on the bot home. */
const MOBILE_PAGE_TITLES: Record<string, string> = {
  '/dashboard': 'Timeline',
  '/tasks': 'Your tasks',
  '/profile': 'Profile',
};

function mobilePageTitle(logicalPath: string): string {
  const exact = MOBILE_PAGE_TITLES[logicalPath];
  if (exact) return exact;
  return findTabByPath(logicalPath)?.label ?? '';
}

/**
 * Full-bleed mobile (PWA) shell with ChatGPT-like keyboard behavior. There is
 * no bottom nav: the chat landing is the bot home, and every other page (the
 * Timeline, Profile, anything a bot navigated to) gets a back bar to it.
 *
 * When a chat textbox is focused, the entire mobile frame snaps to the visual
 * viewport (the space above the keyboard) and only the chat content scrolls.
 */
export function MobileShell({
  isChatRoute,
  children,
}: {
  isChatRoute: boolean;
  children: ReactNode;
}) {
  const { viewportHeight, offsetTop, isKeyboardOpen } = useVisualViewport();
  const isKeyboardMode = isChatRoute && isKeyboardOpen;

  // Bare-bones mobile frame: lock page scrolling and let only in-app regions
  // scroll. For chat, that means the message list is the only scroll container.
  useEffect(() => {
    const htmlOverflow = document.documentElement.style.overflow;
    const bodyOverflow = document.body.style.overflow;
    const bodyOverscrollBehavior = document.body.style.overscrollBehavior;

    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    document.body.style.overscrollBehavior = 'none';

    return () => {
      document.documentElement.style.overflow = htmlOverflow;
      document.body.style.overflow = bodyOverflow;
      document.body.style.overscrollBehavior = bodyOverscrollBehavior;
    };
  }, []);

  // Keyboard mode: use the visual viewport frame (smaller visible screen above
  // keyboard). Non-keyboard mode: use the normal full dynamic viewport.
  const shellTop = isKeyboardMode ? offsetTop : 0;
  const shellHeight =
    isKeyboardMode && viewportHeight != null ? `${viewportHeight}px` : '100dvh';

  return (
    <div
      className="fixed inset-x-0 z-10 grid min-h-0 bg-background"
      style={{
        top: shellTop,
        height: shellHeight,
        gridTemplateRows: 'minmax(0, 1fr)',
      }}
    >
      {!isChatRoute && <MobilePageBar />}
      <main
        className={cn(
          'min-h-0 min-w-0 flex flex-col',
          isChatRoute
            ? 'overflow-hidden'
            : // The page scrolls the full height; its top clears the floating back button.
              'overflow-auto pb-[env(safe-area-inset-bottom)] pt-[calc(env(safe-area-inset-top)+3.75rem)]',
        )}
      >
        {children}
      </main>
    </div>
  );
}

/**
 * A page's floating back button on mobile: liquid glass over the page, which
 * scrolls the full height beneath it. The page's own header carries its title;
 * the button carries the name for screen readers.
 */
function MobilePageBar() {
  const title = mobilePageTitle(toLogicalPath(usePathname()));
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-20 h-[calc(env(safe-area-inset-top)+4rem)] bg-gradient-to-b from-background/90 to-transparent"
      />
      <nav
        aria-label={title ? `${title} navigation` : 'Page navigation'}
        className="pointer-events-none absolute left-0 top-0 z-30 px-3 pt-[calc(env(safe-area-inset-top)+0.5rem)]"
        data-testid="mobile-page-bar"
      >
        <LiquidGlassButton asChild className="pointer-events-auto">
          <WorkspaceLink href="/chat" aria-label="Back to bots" data-testid="mobile-page-back">
            <ChevronLeft className="!h-6 !w-6 -translate-x-px" />
          </WorkspaceLink>
        </LiquidGlassButton>
      </nav>
    </>
  );
}
