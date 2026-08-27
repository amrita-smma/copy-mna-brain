'use client';

import { useEffect, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { MobileBottomNav } from './MobileBottomNav';
import { useVisualViewport } from '@/hooks/use-visual-viewport';

/**
 * Full-bleed mobile (PWA) shell with ChatGPT-like keyboard behavior.
 *
 * When the keyboard is closed:
 * - Content fills the screen above the bottom nav
 * - Bottom nav is visible at the bottom
 *
 * When a chat textbox is focused:
 * - Entire mobile frame snaps to the visual viewport (space above keyboard)
 * - Bottom nav remains pinned at the bottom of that visible frame
 * - Chat input remains in the main area, directly above the nav
 * - Only chat content scrolls
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
        // In keyboard mode the bottom nav is hidden, so the main area takes the
        // entire visible frame above the keyboard.
        gridTemplateRows: isKeyboardMode ? 'minmax(0, 1fr)' : 'minmax(0, 1fr) auto',
      }}
    >
      <main
        className={cn(
          'min-h-0 min-w-0 flex flex-col',
          isChatRoute ? 'overflow-hidden' : 'overflow-auto',
        )}
      >
        {children}
      </main>
      {!isKeyboardMode && (
        <div className="shrink-0">
          <MobileBottomNav />
        </div>
      )}
    </div>
  );
}
