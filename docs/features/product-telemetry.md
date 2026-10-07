# Product telemetry (PostHog)

Analytics is PostHog, reached three ways. All three exist because ad/tracker
blockers silently drop a meaningful slice of browser-side analytics, which makes
a blocked user indistinguishable from an absent one.

**1. Same-origin ingest proxy (`/ingest`).** `posthog-js` is initialised in
`src/instrumentation-client.ts` with `api_host: '/ingest'` rather than PostHog's
own domain, so blockers filtering by hostname (`*.posthog.com`) don't match.
`/ingest` is a pair of `rewrites()` in `next.config.ts`, not a route handler:
rewrites resolve in the platform's edge routing layer, so no serverless function
is invoked per captured event. PostHog serves ingestion and static assets from
two different hosts, so `/ingest/static/*` and `/ingest/*` are rewritten
separately — see `posthogUpstreams` in `src/lib/posthog-proxy.ts`, which derives
the `<region>-assets` host and returns nothing when PostHog is unconfigured (the
path then simply 404s). `skipTrailingSlashRedirect` is on because posthog-js
addresses its endpoints with trailing slashes (`/e/`, `/flags/?v=2`).

`src/proxy.ts` matches `/ingest/:path*` purely to **strip credentials** —
the browser attaches session cookies to `/ingest` because it is same-origin and
cannot know the request is about to be proxied to a vendor. Without that strip,
every captured event would ship a live session token to PostHog.

**2. Identity.** `PostHogIdentityTracker` (mounted once in `Providers`)
identifies the user off the resolved NextAuth session, keyed on their **UUID**,
and refreshes person properties via `setPersonProperties`. It deliberately does
not live on the login page: `before_send` drops everything captured on `/login`
(see `src/lib/posthog-events.ts`), and since `identify()` is itself a captured
`$identify` event, identifying there sent nothing — losing the anonymous →
identified merge and the `email` / `name` person properties. Identity events are
now explicitly exempt from that path filter.

The tracker also registers the user's **email as a super property**, so every
event carries both the email and the UUID (the UUID is already the `distinct_id`,
so it needs no equivalent). This is an interim measure while identities migrate
from email-keyed to UUID-keyed persons — it makes a user findable by raw event
search without depending on person profiles having merged. **To stop sending
emails, flip `SEND_EMAIL_WITH_EVENTS` in `src/lib/posthog-identity.ts` to
`false`.** Do not simply delete the `register` call: super properties persist in
each browser's localStorage, so a deleted call would leave existing sessions
stamping email indefinitely. The flag drives an `unregister` on the off path,
which clears the stored value. (`posthog.reset()` on sign-out already clears it
too, so a shared browser never carries one user's email into the next session.)

**3. Server-side capture.** The events that matter most for per-user attribution
are emitted with `posthog-node`, where no blocker can reach them:
`user_signed_in` (`src/auth.ts`), `deal_promoted` / `deal_demoted`
(`CompanyService.promote` **and** `promoteMany`, so chat bulk moves are counted
too — those carry `bulk: true` instead of a company name), `file_uploaded`
(`FileService.processUpload`) and `ai_screening_started`
(`ScreeningService.prepare`). Their client-side counterparts were removed, so
these are not double counted. `promote` takes a trailing telemetry-only `opts`
argument (`triggeredByUserId`, `hasDocument`) — `hasDocument` is passed in
explicitly because the attachment is uploaded *after* the promote call returns,
so the server cannot observe it. Use
`captureWorkspaceEvent` for anything inside a workspace and `captureUserEvent`
only where there genuinely is no workspace (sign-in). Both enqueue and then hand
`flushPostHog()` to `waitUntil`, because `posthog-node`'s `capture()` only
queues: without that, a short request can return and have its instance frozen
before the event's POST completes, silently losing it. Server-side capture covers
agent-tool and pipeline callers that have no browser at all, but gives up
autocapture, `$pageview` and session replay — it complements the client, it does
not replace it.

**Blocked-client signal.** `ClientHealthProbe` HEADs both `/ingest/static/array.js`
and the capture endpoint `/ingest/i/v0/e/` (`PROBE_PATHS`) once per tab session
for a signed-in user; a rejected fetch (`ERR_BLOCKED_BY_CLIENT`) on *either*
means blocked, while any HTTP response — including a 5xx — counts as reachable,
so a broken proxy is never misreported as an ad blocker. Both are probed because
they are two different rewrites pointed at two different upstreams (asset host
vs ingestion host): a blocker that eats only the request carrying the data left
the asset probe green and the user silently dark. A blocked client POSTs
to `/api/client-health`, which records `client_telemetry_blocked` server-side
against that user. The route **awaits** `flushPostHogWithin()` before responding
— it has no other work to hide the flush behind, and a serverless instance
frozen at response time drops a captured-but-unflushed event. The wait is capped
at `FLUSH_WAIT_MS` (3s) because PostHog's own retry budget is tens of seconds; past
the cap the flush finishes in the background under `waitUntil`. The probe also runs on `/workspace` and `/consent`, which
resolve no workspace, so `ClientHealthService` falls back to `captureUserEvent`
rather than stamping the fail-closed `NO_ACTIVE_WORKSPACE_ID` sentinel as a real
PostHog group. The route and probe paths deliberately avoid the words
`analytics`, `tracking`, `telemetry`, `posthog` and `ph`, all of which appear in
the filter lists this is trying to measure.

**4. Activity heartbeat — the usage tracker.** `src/lib/posthog-heartbeat.ts`,
fired from `recordActivity` in `src/proxy.ts`. This is the authoritative "who is
using the product, and how much" signal, and the only one an ad blocker cannot
touch: the proxy already decodes the session JWT on every gated request, so
usage is counted server-side with nothing running in the browser.

Time is sliced into fixed five-minute windows (`HEARTBEAT_INTERVAL_MS`) and each
user emits at most one `user_activity_heartbeat` per window **per instance**,
carrying that window's index as `heartbeat_bucket`. The bucket is derived from
wall-clock time rather than from process state, which is what lets the throttle
be a per-instance in-memory `Map` with no shared dedup infrastructure and no
database round-trip on the request path: two instances serving the same user in
one window build a *byte-identical* event — same `$insert_id`
(`<user>:<bucket>`) and same `timestamp` (the window's start, not the moment of
the request, since PostHog's dedup tuple includes it) — so the duplicate is
dropped at ingest. `uniqExact(heartbeat_bucket)` collapses any that slip
through. Active time is `distinct buckets x interval`.

This measures **active** time (windows containing at least one request), not
time-on-page. That is deliberate: the client-side `$prev_pageview_duration` it
replaces counts an idle background tab as usage. For the same reason
`isActivityPath` excludes `/api/auth/*` — the NextAuth client polls
`/api/auth/session` on an interval and on window focus, which would make an
abandoned tab read as active forever — along with `/ingest`, `/api/cron/*`,
`/api/queues/*`, `/api/healthcheck` and `/api/client-health`.

The heartbeat posts directly to PostHog's `/i/v0/e/` capture endpoint with
`fetch` (via `waitUntil`, so it never delays the response). A bare `fetch`
rather than `posthog-node` because the proxy runs per request with no
meaningful process lifetime to flush a buffered client against — there is
nothing for a client library to batch. It deliberately does *not* route through
our own `/ingest` rewrite either: the request originates on the server, where
there is no blocker to evade, and doing so would bounce it back through the
proxy. The `email` event property honours the same `SEND_EMAIL_WITH_EVENTS` kill
switch as the client super property, so flipping that flag stops both surfaces.
`$set: { email }` is *not* gated on it — that flag governs per-event stamping,
not the person properties `identify` would set anyway, and it is what gives a
permanently blocked user a searchable person profile instead of a bare UUID.
