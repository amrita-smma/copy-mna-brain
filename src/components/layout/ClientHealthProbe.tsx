'use client';

import { useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import {
  REPORT_PATH,
  hasReported,
  markReported,
  probeIngest,
} from '@/lib/client-health';

/**
 * Reports back when an ad blocker is dropping our `/ingest` PostHog proxy.
 *
 * Runs only for a signed-in user: the report is what tells us *which* user is
 * dark, and `/api/client-health` is session-gated anyway. Fires once per tab
 * session, and only when the probe actually fails — a reachable client stays
 * silent, since its ordinary PostHog events already prove it isn't blocked.
 */
export default function ClientHealthProbe() {
  const { user } = useAuth();
  const userId = user?.id;

  useEffect(() => {
    if (!userId) return;

    const storage = typeof window === 'undefined' ? null : window.sessionStorage;
    if (hasReported(storage)) return;

    let cancelled = false;

    void (async () => {
      const outcome = await probeIngest(fetch.bind(window));
      if (cancelled || outcome === 'reachable') return;

      // Mark before sending: a failed report shouldn't make every subsequent
      // page load retry a probe we already know the answer to.
      markReported(storage);
      try {
        await fetch(REPORT_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'ingest_blocked' }),
          keepalive: true,
        });
      } catch {
        // Nothing useful to do — this is diagnostics, never user-facing.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId]);

  return null;
}
