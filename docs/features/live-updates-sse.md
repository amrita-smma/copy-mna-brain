# Live updates (Server-Sent Events)

State a view shows while it is changing elsewhere — a screening finishing, a
workforce run's trace growing, a file processing, a vote landing, a job
ending — is pushed over **one** Server-Sent Events connection per tab, driven
by Redis pub/sub, with no database work on the stream itself. Nothing in the
browser watches server state on its own timer; a timer is only the fallback
while the stream is down. The rule and review checklist:
`.claude/rules/live-updates.md`.

## The pieces

- **Topics** — `src/lib/live/topics.ts` (`LIVE_TOPICS`). A topic names a
  kind of server state a view keeps live; `ids` names the rows when the
  writer knows them, and a view that holds a specific record filters on them.

  | Topic | Fires when | `ids` |
  |---|---|---|
  | `screenings` | a screening's state or result changes | screening ids |
  | `workforce` | a queue row is queued, started, paused, decided, finished, failed, seen, reordered — and, coalesced to once a second, as a running agent's checkpoint grows (`LiveTraceCallbackHandler`) | run ids |
  | `ai-opinion` | an AI Opinion run starts, finishes or fails | company ids |
  | `sourcing` | a company enters, leaves or is dropped from Pending Confirmation | company ids |
  | `documents` | an attachment's processing status moves | document ids |
  | `company-card` | a card run writes the row, or the copilot edits a section | company ids |
  | `contacts` | a contact search saves CRM contacts for a company | company ids |
  | `voting` | a round starts, a ballot lands, it is sent back, cancelled, concluded, synthesised | company ids |
  | `jobs` | a `jobs` row starts or reaches a terminal state (runner, stuck-job sweep) | job ids |
  | `files` | a Smart File lands, processes, fails, is dropped or approved (upload, reprocess, fund update extraction, approval) | file ids |
  | `insights` | an insight gains a version (edit, refresh, rollback) | insight ids |
  | `user-tasks` | a user's personal tasks change | user ids |
  | `crm-overview` | a contact's relationship overview goes pending, ready or failed | correspondent ids |

- **Publish on write** — `publishLiveEvent(workspaceId, topic, ids?)` in
  `src/lib/server/liveEvents.ts`, called by the service, job handler,
  workforce step, route or agent tool right after the write commits (after
  `withTransaction` returns, never inside it). It publishes
  `{ type: 'invalidate', topic, ids }` to the Redis channel
  `ws:<workspaceId>:events`. Repositories stay pure data access. Writers
  outside any request (the dispatcher, `runAgent`'s finish steps, the job
  runner, the reaper, the stuck-job sweep) publish with the row's own
  `workspace_id`; a job dispatched with none has nothing to publish to.
  Best-effort: a Redis failure, or no `REDIS_URL`, is logged once and ignored.
- **One route, `GET /api/events`** — subscribes to the workspace channel and
  forwards each message as a `data:` frame. No query params, so the
  connection is opened once by the app shell and never reopened on
  navigation. Opens with `{ type: 'resync' }` (pub/sub does not replay), sends
  a heartbeat comment every 15 s, and closes itself at 240 s so `EventSource`
  reconnects. Answers 503 without Redis.
- **One client** — `LiveEventsProvider` (`src/components/live/LiveEventsProvider.tsx`,
  mounted in `AppShell`) maps each `invalidate` frame to
  `queryClient.invalidateQueries({ queryKey: [topic] })` and `resync` to
  every topic, and feeds the module-level `liveBus`
  (`src/lib/live/liveBus.ts`), which holds the listeners and the connected
  flag so code outside React can hear frames too. Hooks:
  `useLiveRefetchInterval(fallbackMs)`, `useLiveTopic(topic, handler)`,
  `useLiveConnected()`; for a promise, `waitForLiveEvent(topic, { id,
  timeoutMs })` and `liveFallbackMs(fallbackMs)`.

## Writing a live view

A react-query view keys its query under the topic and takes its refetch
interval from the provider:

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
keeps its own state subscribes with `useLiveTopic`, filters on the ids, and
feeds `useLiveRefetchInterval` to its own fallback timer:

```ts
const pollMs = useLiveRefetchInterval(POLL_MS);
useLiveTopic(LIVE_TOPICS.voting, (ids) => {
  if (ids && !ids.includes(companyId)) return;
  void load();
});
```

A wait that is a promise rather than a component — `waitForJob`,
`waitForWorkforceRun` (`src/lib/jobs/useJob.ts`) — arms `waitForLiveEvent`
*before* each read so a frame landing during the read is not missed, then
re-reads on the frame or after `liveFallbackMs(intervalMs)`.

The views on this today: the Pipeline (screening tasks, the pending
screening set, the processing AI Opinion set); the Company Detail page and
dialog (screenings while one is pending, attachments while one is
processing, the Company Card while a run is in flight and while the copilot
rewrites a section, the contact search, the voting round); Market
Screening's contact searches and its scan; the sidebar's Workforce and
Sourcing badges; AI Workforce's task list and both trace canvases; Smart
Files' lists and `?file=` deep link; the CRM's Get Full Profile button and
contact overview; the CoPilot insight edit card; personal tasks; and the
graph sync and slide generation waits.

## Adding a topic

1. Add it to `LIVE_TOPICS`, documenting what `ids` are.
2. Call `publishLiveEvent` after **every** write that changes that state —
   grep the status column; each write site publishes. In the service, job
   handler or tool, never the repository.
3. Key the view's query under it, or subscribe with `useLiveTopic`, with
   `useLiveRefetchInterval` as the fallback.
4. Unit-test the publish: the mocked `publishLiveEvent` is called with the
   workspace, topic and ids, and its `invocationCallOrder` is after the
   write's.

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
