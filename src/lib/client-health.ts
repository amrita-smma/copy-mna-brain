/**
 * Detects when an ad blocker is eating our own `/ingest` PostHog proxy.
 *
 * Without this, a blocked user is simply absent from PostHog — indistinguishable
 * from a user who didn't visit. That's the failure mode that makes "I can't see
 * this person's telemetry" so hard to diagnose: there's no denominator, so you
 * can't tell whether it's one user or a fifth of them.
 *
 * The report goes to a first-party API route, not to PostHog — PostHog is the
 * thing that's blocked. The route deliberately avoids the words `analytics`,
 * `tracking`, `telemetry`, `posthog` and `ph` in its path, all of which appear
 * in the filter lists this is trying to measure.
 */

import { INGEST_PATH_PREFIX } from '@/lib/posthog-proxy';

/**
 * A small, cacheable asset served through the same proxy path as capture
 * traffic. Probing a real PostHog asset (rather than, say, our own `/favicon.ico`)
 * is the point: it exercises the exact path prefix and a filename that filter
 * lists target.
 */
export const PROBE_PATH = `${INGEST_PATH_PREFIX}/static/array.js`;

/** Where a blocked client reports in. Kept free of blocklist trigger words. */
export const REPORT_PATH = '/api/client-health';

/** sessionStorage key — report at most once per tab session, not per page view. */
export const REPORTED_FLAG = 'mnab.clientHealth.reported';

export type ProbeOutcome = 'reachable' | 'blocked';

/**
 * Probe the ingest path.
 *
 * A blocked request fails at the network layer (`ERR_BLOCKED_BY_CLIENT`), which
 * surfaces as a rejected fetch. Any HTTP *response* — including a 404 or a 500
 * — means the request left the browser, so the blocker is not the problem and
 * this reports `reachable`. Being conservative in that direction matters: a
 * false "blocked" would send us chasing an ad blocker when the real fault is
 * our own proxy.
 */
export async function probeIngest(
  fetchImpl: typeof fetch,
  path: string = PROBE_PATH,
): Promise<ProbeOutcome> {
  try {
    await fetchImpl(path, { method: 'HEAD', cache: 'no-store' });
    return 'reachable';
  } catch {
    return 'blocked';
  }
}

/**
 * Whether this tab session has already filed a report. Storage being
 * unavailable (private mode, a blocker that stubs it out) is treated as "not
 * yet reported" — a duplicate report is far cheaper than a missing one, which
 * is the entire bug class this exists to surface.
 */
export function hasReported(storage: Pick<Storage, 'getItem'> | null | undefined): boolean {
  try {
    return storage?.getItem(REPORTED_FLAG) === '1';
  } catch {
    return false;
  }
}

/** Mark this tab session as having reported. Never throws. */
export function markReported(storage: Pick<Storage, 'setItem'> | null | undefined): void {
  try {
    storage?.setItem(REPORTED_FLAG, '1');
  } catch {
    // Storage unavailable — we'll just report again next page load.
  }
}
