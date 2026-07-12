import posthog from 'posthog-js'

const UNAUTHENTICATED_PATHS = ['/login', '/reset-password']

posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
  api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
  defaults: '2026-01-30',
  capture_exceptions: true,
  before_send: (event) => {
    const path = window.location.pathname
    if (UNAUTHENTICATED_PATHS.some((p) => path === p || path.startsWith(p + '/'))) {
      return null
    }
    return event
  },
})
