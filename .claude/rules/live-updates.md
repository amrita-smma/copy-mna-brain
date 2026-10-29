# Live Updates

Anything the browser shows while it is changing on the server — a job
finishing, a run's trace growing, a file processing, a vote landing — gets
the change **pushed** over the workspace live stream. Nothing in the client
watches server state on its own timer.

## The rule

1. **Publish on write.** The service, job handler, workforce step or agent
   tool that changes the state calls `publishLiveEvent(workspaceId, topic,
   ids)` (`src/lib/server/liveEvents.ts`) *after* the write commits — after
   `withTransaction` returns, never inside it. Repositories stay pure.
   Writers outside a request (the dispatcher, `runAgent`, the reaper, the
   stuck-job sweep) publish with the row's own `workspace_id`; a row with
   none has nothing to publish to.
2. **One topic per kind of state**, in `LIVE_TOPICS` (`src/lib/live/topics.ts`),
   with `ids` naming the rows so a view holding one record filters on them.
3. **A view subscribes; it does not poll.** Either:
   - a react-query hook keyed under the topic
     (`[LIVE_TOPICS.screenings, slug, companyId]`) with
     `refetchInterval: useLiveRefetchInterval(oldCadence)`, or
   - a view with its own state calling `useLiveTopic(topic, ids => …)`,
     filtering on `ids`, or
   - a promise outside React (`waitForJob`, `waitForWorkforceRun` in
     `src/lib/jobs/useJob.ts`) built on `waitForLiveEvent`
     (`src/lib/live/liveBus.ts`).
4. **A timer is the fallback only.** Its interval is
   `useLiveRefetchInterval(fallbackMs)` / `liveFallbackMs(fallbackMs)`: the
   view's old cadence while the stream is down (before it first opens, during
   a reconnect, with no `REDIS_URL`), the slow 60 s safety net while it is
   up. A bare `setInterval(fetch, N)` or `refetchInterval: N` in a view is a
   poller and is not accepted.
5. **A tool call that must wake a view** publishes too — a LangChain tool
   writing a row the user is looking at (`update_company_card_section`) is a
   writer like any service.

What this is not for: a request/response handshake (the chat Stop button
waiting a few hundred milliseconds for the server turn to release the
thread), a clock tick for relative times, an animation.

## Reviewing a diff

Reject a diff that:

- adds `setInterval`, a `setTimeout` chain, `useVisibleInterval` or a
  react-query `refetchInterval` that re-reads server state without
  `useLiveRefetchInterval` / `liveFallbackMs` as its interval **and** a
  `useLiveTopic` / topic-keyed query / `waitForLiveEvent` as the update path
- writes state a live view shows without calling `publishLiveEvent` after
  the write (a new status column, a new job type, a new tool that edits a
  shown row)
- publishes inside a transaction, or from a repository
- adds a topic without the writer, or a writer without listing every write
  site (grep the status column: each write publishes)
- filters a view on `ids` the writer does not send, or sends ids of a
  different kind than the topic documents
- polls the database from a stream route (`GET /api/events` forwards Redis
  frames and runs no queries)

Full contract and the list of topics and views: `docs/features/live-updates-sse.md`.
