# Live updates (Server-Sent Events)

Views that show state changing elsewhere — a screening finishing, an AI
Workforce run starting, an AI Opinion verdict landing, a deal arriving in
Sourcing — get it pushed over **one** Server-Sent Events connection per tab,
driven by Redis pub/sub, with no database work on the stream itself.

## The pieces

- **Topics** — `src/lib/live/topics.ts` (`LIVE_TOPICS`: `screenings`,
  `workforce`, `ai-opinion`, `sourcing`). A topic names a kind of server
  state a view keeps live.
- **Publish on write** — `publishLiveEvent(workspaceId, topic, ids?)` in
  `src/lib/server/liveEvents.ts`, called by the service (or workforce step,
  job handler, route) right after the write commits. It publishes
  `{ type: 'invalidate', topic, ids }` to the Redis channel
  `ws:<workspaceId>:events`. Repositories stay pure data access. Writers
  outside any request (the dispatcher, `runAgent`'s finish steps, the reaper)
  publish too, with the row's own `workspace_id`. Best-effort: a Redis
  failure, or no `REDIS_URL`, is logged once and ignored.
- **One route, `GET /api/events`** — subscribes to the workspace channel and
  forwards each message as a `data:` frame. No query params, so the
  connection is opened once by the app shell and never reopened on
  navigation. Opens with `{ type: 'resync' }` (pub/sub does not replay), sends
  a heartbeat comment every 15 s, and closes itself at 240 s so `EventSource`
  reconnects. Answers 503 without Redis.
- **One client, `LiveEventsProvider`** (`src/components/live/LiveEventsProvider.tsx`,
  mounted in `AppShell`) — maps each `invalidate` frame to
  `queryClient.invalidateQueries({ queryKey: [topic] })`, and `resync` to
  every topic. It also exposes `useLiveRefetchInterval(fallbackMs)` and
  `useLiveTopic(topic, handler)`.

## Writing a live view

A live view is an ordinary react-query hook whose key starts with its topic
and whose refetch interval comes from the provider:

```ts
const refetchInterval = useLiveRefetchInterval(5_000); // the old polling cadence
const { data } = useQuery({
  queryKey: [LIVE_TOPICS.screenings, workspaceSlug, companyId],
  queryFn: () => getScreenings({ companyId }),
  enabled: hasPendingScreening,
  refetchInterval,
});
```

While the stream is up the query refetches when a frame names its topic
(and once a minute as a safety net); while it is down — before it first
opens, during a reconnect, on a deployment without Redis — it polls at
`fallbackMs`, so nothing is slower than it was with polling. A view that
keeps its own state instead of a query (`WorkforceTasks`, with its drag
guard) subscribes with `useLiveTopic` and uses the same interval for its
own poller.

The views on this today: the Pipeline (screening tasks, the pending
screening set, the processing AI Opinion set), the Company Detail page and
dialog (a company's screenings while one is pending), the sidebar's
Workforce and Sourcing badges, and AI Workforce's task list.

## Adding a topic

1. Add it to `LIVE_TOPICS`.
2. Call `publishLiveEvent` after every write that changes that state — in the
   service, never the repository.
3. Key the view's query under it, with `useLiveRefetchInterval` as the
   fallback.

## The bots stream

`GET /api/bots/events` is the Copilot bots' own push stream (who is thinking,
a reply landing), on the channels `ws:<workspaceId>` and
`ws:<workspaceId>:user:<userId>`, with a snapshot on connect and a 10 s
reconcile of the expiring presence keys. See *Live presence* in
[`copilot-bots.md`](copilot-bots.md). Both streams share the encoding
helpers in `src/lib/server/sse.ts` and the `useEventStream` hook
(`src/hooks/useEventStream.ts`), which reopens a CLOSED source itself with a
1–30 s backoff, because the browser does not retry after a non-stream
response (a 401 while the session refreshed, a 503 while Redis was down).

Both are `session`-authenticated (via `proxy.ts`): the browser's
`EventSource` sends the NextAuth cookie automatically — it cannot set the
`X-Api-Secret` header.
