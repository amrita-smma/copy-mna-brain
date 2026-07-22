'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import {
  isAllowedAncestor,
  isEmbedded,
  isLauncherMessage,
  postToLauncher,
} from '@/lib/iframe';

/**
 * The brain side of the launcher↔brain postMessage bridge. Renders nothing;
 * safe to mount once inside the client providers (needs `SessionProvider` and
 * router context). No-op when the app is not embedded in a frame.
 *
 * Outbound (brain → launcher), via `postToLauncher`:
 *   - `ready`       once the app has mounted.
 *   - `signed-out`  after the launcher-requested logout completes.
 *   - `auth-expired` emitted elsewhere (`src/lib/api/client.ts`,
 *     `ProtectedRoute`) when a request 401s or the session is gone.
 *
 * Inbound (launcher → brain), only after validating `event.origin` against the
 * allowlist AND `data.source === 'brain-portal'` (the neutral shared tag):
 *   - `logout`   sign out locally, then ack with `signed-out`.
 *   - `navigate` same-origin, relative-path navigation.
 */
export function IframeBridge() {
  const router = useRouter();
  const { signOut } = useAuth();

  useEffect(() => {
    if (!isEmbedded()) return;

    // Announce we're up so the launcher can drop any "loading" chrome.
    postToLauncher({ type: 'ready' });

    const onMessage = (event: MessageEvent) => {
      // Strict origin allowlisting — never trust a message from an
      // unrecognised parent, and never react to our own outbound messages.
      if (!isAllowedAncestor(event.origin)) return;
      if (!isLauncherMessage(event.data)) return;

      switch (event.data.type) {
        case 'logout': {
          // Propagate logout initiated in the launcher, then acknowledge so
          // the launcher can finish tearing down its own state.
          void signOut().finally(() => postToLauncher({ type: 'signed-out' }));
          break;
        }
        case 'navigate': {
          const path = event.data.path;
          // Same-origin, relative paths only — never an open redirect.
          if (typeof path === 'string' && path.startsWith('/') && !path.startsWith('//')) {
            router.push(path);
          }
          break;
        }
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [router, signOut]);

  return null;
}
