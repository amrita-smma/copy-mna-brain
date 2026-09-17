import posthog from 'posthog-js'
import { workspaceIdentityForPath } from '@/lib/posthog-workspace'

const UNAUTHENTICATED_PATHS = ['/login', '/reset-password']

const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim()
const posthogHost = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim()

// Local env templates contain placeholders; initializing with them sends
// analytics requests to nonexistent routes under the current workspace.
if (posthogKey && posthogKey !== 'posthog_key' && posthogHost !== 'posthog_host') {
  posthog.init(posthogKey, {
    // Routed through our own `/ingest` reverse proxy (`src/app/ingest/[...path]/route.ts`)
    // rather than posthogHost directly, so ad blockers that block PostHog's
    // domain by hostname don't silently drop capture/flags/session-recording
    // traffic. `ui_host` keeps toolbar/session-replay links pointed at the
    // real PostHog instance.
    api_host: '/ingest',
    ui_host: posthogHost,
    defaults: '2026-01-30',
    capture_exceptions: true,
    before_send: (event) => {
      if (!event) return event
      const path = window.location.pathname
      if (UNAUTHENTICATED_PATHS.some((p) => path === p || path.startsWith(p + '/'))) {
        return null
      }

      // Stamp the active workspace from the live URL on every event. This runs
      // synchronously at capture time — including PostHog's own auto-captured
      // `$pageview` on page load — so a workspace switch (a hard navigation) can
      // never leave an event attributed to the previous workspace. See
      // `@/lib/posthog-workspace` for why this is derived from the URL rather
      // than a React-effect-registered super property.
      const props = (event.properties ??= {})
      const identity = workspaceIdentityForPath(path)
      if (identity) {
        props.workspace_slug = identity.slug
        if (identity.id) {
          props.workspace_id = identity.id
          props.$groups = { ...(props.$groups ?? {}), workspace: identity.id }
        } else {
          // Slug known but UUID not resolved yet (very first load before the
          // map is populated) — never carry a stale id from a persisted super
          // property.
          delete props.workspace_id
          if (props.$groups) delete props.$groups.workspace
        }
      } else {
        // Not a workspace-scoped route (e.g. the workspace picker) — strip any
        // workspace attribution so these events aren't misfiled.
        delete props.workspace_slug
        delete props.workspace_id
        if (props.$groups) delete props.$groups.workspace
      }

      return event
    },
  })
}
