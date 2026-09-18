import posthog from 'posthog-js'
import { transformEvent } from '@/lib/posthog-events'

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim()
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim()

// Local env templates contain placeholders; initializing with them sends
// analytics requests to nonexistent routes under the current workspace.
if (posthogKey && posthogKey !== 'posthog_key' && posthogHost !== 'posthog_host') {
  posthog.init(posthogKey, {
    // Routed through our own same-origin `/ingest` reverse proxy rather than
    // posthogHost directly, so ad blockers that block PostHog's domain by
    // hostname don't silently drop capture/flags/session-recording traffic.
    // The proxy is a pair of `rewrites()` in `next.config.ts` (edge-level on
    // Vercel, no function invocation per event); `src/proxy.ts` strips
    // credentials off the request before it leaves our origin.
    // `ui_host` keeps toolbar/session-replay links pointed at the real
    // PostHog instance.
    api_host: '/ingest',
    ui_host: posthogHost,
    defaults: '2026-01-30',
    capture_exceptions: true,
    // See `@/lib/posthog-events` — drops telemetry captured on the logged-out
    // pages (but never identity events) and stamps the active workspace.
    before_send: (event) => transformEvent(event, window.location.pathname),
  })
}
