/**
 * Upstream resolution for the same-origin `/ingest` PostHog reverse proxy.
 *
 * The proxy exists because ad/tracker blockers block by hostname: requests to
 * `*.posthog.com` are dropped before they leave the browser, silently losing
 * analytics for a meaningful slice of users. Same-origin `/ingest/*` traffic
 * isn't caught by those hostname lists.
 *
 * It is implemented as a pair of `rewrites()` in `next.config.ts` rather than a
 * route handler. A rewrite is resolved by the platform's edge routing layer, so
 * it costs no serverless invocation per captured event and can't reintroduce
 * the body-streaming/hop-by-hop-header class of bug a hand-rolled `fetch`
 * proxy is prone to. `src/proxy.ts` strips credentials off the request on the
 * way through — see `INGEST_PATH_PREFIX` there.
 *
 * PostHog serves ingestion and static assets from two different hosts, so the
 * two have to be rewritten separately.
 */

/** The same-origin path posthog-js is pointed at (`api_host`). */
export const INGEST_PATH_PREFIX = '/ingest';

export interface PostHogUpstreams {
  /** Host that receives capture / flags / replay traffic. */
  apiHost: string;
  /** Host that serves the lazily-loaded `/static/*.js` bundles. */
  assetHost: string;
}

/** Placeholder values that `.env.example` ships; never a real host. */
const PLACEHOLDER_HOSTS = new Set(['posthog_host', '']);

/**
 * PostHog Cloud regions serve assets from a sibling `<region>-assets` host —
 * `https://us.i.posthog.com` pairs with `https://us-assets.i.posthog.com`.
 */
const CLOUD_HOST_PATTERN = /^https:\/\/([a-z0-9-]+)\.i\.posthog\.com$/;

/**
 * Resolve `NEXT_PUBLIC_POSTHOG_HOST` into the two upstreams the rewrites need,
 * or null when PostHog isn't configured (so no rewrite is registered at all and
 * `/ingest/*` simply 404s instead of proxying to nowhere).
 *
 * A self-hosted instance serves its own `/static/*`, so both upstreams collapse
 * onto the configured host.
 */
export function posthogUpstreams(host: string | undefined): PostHogUpstreams | null {
  const trimmed = host?.trim() ?? '';
  if (PLACEHOLDER_HOSTS.has(trimmed)) return null;

  // A trailing slash would produce `//static/...` once the rewrite appends.
  const apiHost = trimmed.replace(/\/+$/, '');
  if (!apiHost) return null;

  const cloudRegion = CLOUD_HOST_PATTERN.exec(apiHost);
  const assetHost = cloudRegion
    ? `https://${cloudRegion[1]}-assets.i.posthog.com`
    : apiHost;

  return { apiHost, assetHost };
}

/** Whether `pathname` belongs to the ingest proxy. */
export function isIngestPath(pathname: string): boolean {
  return (
    pathname === INGEST_PATH_PREFIX || pathname.startsWith(`${INGEST_PATH_PREFIX}/`)
  );
}

/**
 * Request headers that must never reach PostHog.
 *
 * Browser requests to same-origin `/ingest` carry our session cookies by
 * default — the browser has no idea the request is about to be proxied to a
 * third party. PostHog needs none of these, and forwarding them would hand a
 * vendor a live session token on every captured event.
 */
export const CREDENTIAL_HEADERS = ['cookie', 'authorization', 'x-api-secret'];

/** Remove every credential header from `headers`, in place. */
export function stripCredentialHeaders(headers: Headers): void {
  for (const header of CREDENTIAL_HEADERS) {
    headers.delete(header);
  }
}
