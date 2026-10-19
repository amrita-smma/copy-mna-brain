'use client';

import { createPortal } from 'react-dom';
import { Loader2 } from 'lucide-react';

/**
 * Full-screen blur shown while a workspace switch navigates away.
 *
 * Portalled to `document.body` because the switchers render inside the
 * sidebar, which is its own stacking context — rendered in place, the
 * overlay's `z-50` only competes inside the sidebar, and positioned content
 * in the page (e.g. the Pipeline tables' sticky company and actions columns)
 * paints over it unblurred.
 */
export function WorkspaceSwitchingOverlay() {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>,
    document.body,
  );
}
