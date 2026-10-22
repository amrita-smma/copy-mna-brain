# Live updates (Server-Sent Events)

The pipeline and company-detail views get live progress over **Server-Sent
Events** instead of `setInterval` polling. A single long-lived connection per
client replaces repeated `GET /api/screenings` and `GET /api/companies`
requests: the server re-queries on an interval and only emits a `data:` frame
when the relevant state actually changes (idle ticks send a heartbeat comment).

- `GET /api/screenings/stream?companyId=…` (or `?inScreening=true`) — pushes the full
  screenings list whenever any row's `state`/`result` changes. Backs the Company
  Detail / dialog screening progress and the Pipeline's Pending Confirmation + L0
  pending-screening set.
- `GET /api/companies/stream` — pushes the compact set of companies with an
  in-flight AI Opinion run; when that set changes the client refreshes the list
  once so the spinner swaps for the verdict.
- `GET /api/bots/events` — the Copilot bots' live state (who is thinking, a
  reply landing, which is merged into the thread on screen). Unlike the two above it is **push**,
  not a DB re-query: it subscribes to Redis pub/sub and forwards, with a 10 s
  reconcile of the expiring keys. See *Live presence* in
  [`copilot-bots.md`](copilot-bots.md).

All three are `session`-authenticated (via `proxy.ts`): the browser's `EventSource`
sends the NextAuth cookie automatically — it cannot set the `X-Api-Secret`
header. The reusable stream builder lives in `src/lib/server/sse.ts`
(`changeStream`); the client subscribes via the `useEventStream` hook
(`src/hooks/useEventStream.ts`). Streams self-close at a lifetime cap below the
function timeout and `EventSource` reconnects automatically. The browser does
not retry after a response that is not a stream (a 401 while the session was
refreshing, a 503 while Redis was down): the source goes CLOSED for good, so
`useEventStream` reopens a CLOSED source itself with a 1–30 s backoff and a
tab left open recovers once the server is well again.
