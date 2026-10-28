# Langfuse Agent Tracing

Every LLM call this app makes is traced to [Langfuse](https://langfuse.com):
prompts, completions, tool calls, token counts, latency, and the effort tier
that produced them.

- **Where the traces go.** A self-hosted Langfuse v3 instance on EC2, one per
  environment, built by [`terraform/langfuse`](../../terraform/langfuse/README.md).
  Locally, the stack in `docker-compose.yml` (`pnpm docker:run-langfuse`,
  http://localhost:3030).
- **What turns it on.** `LANGFUSE_SECRET_KEY` and `LANGFUSE_PUBLIC_KEY` both
  being set. Nothing else.

## The three modules

Call sites import `@/lib/langfuse`. It is split in three, and the split is
load-bearing rather than cosmetic:

| Module | Holds | May import `node:`? |
|---|---|---|
| `src/lib/langfuseClient.ts` | the gate, the shared handler, `flushLangfuse` | **no** |
| `src/lib/langfuseUser.ts` | the AsyncLocalStorages carrying who a run belongs to, and which workspace | yes (`node:async_hooks`) |
| `src/lib/langfuse.ts` | `withLangfuseCallbacks` — where the two meet; re-exports the client | — |

The workforce drain lives in `invokeAgent`'s `finally` — a `'use step'`
function, **never** `runAgent`'s `'use workflow'` body. Whatever a workflow
body references is compiled into the WDK workflow bundle: a first-party module
that touches a `node:` builtin **fails the build** — reachable from the
workflow body or not — and a drain from the body once bundled the whole
langfuse SDK (langsmith requires `node:worker_threads` at module scope) into
the sandbox and crashed every workforce run before its first step, the
2026-10-12 outage. The client/user split stays load-bearing regardless:
`runAgent.ts` still imports `flushLangfuse` from `@/lib/langfuseClient`
directly rather than through the barrel, so a future reference from the
workflow body breaks the build instead of production.

Adding a `node:` import to `langfuseClient.ts` — or an import of
`langfuseUser` — breaks `next build` with `workflow-node-module-error`, pointing
at a line that looks innocent. `src/lib/langfuseClient.test.ts` walks the import
graph and fails in a second instead.

`@/lib/workspace` carries the same `node:async_hooks` import without trouble
because only `'use step'` functions reach it; a step is not part of the workflow
bundle.

## The gate

`src/lib/langfuseClient.ts` is the only place that decides whether to trace:

```ts
isLangfuseEnabled()   // both keys set, and not killed by the switch
```

Both keys, not just the secret: Langfuse authenticates ingestion with the pair,
so a half-configured environment would emit traces rejected at the far end with
nothing failing locally to say so.

This is deliberately *not* environment-aware. It used to be
`development || VERCEL_ENV === 'preview'`, which meant production agent
behaviour — the runs that actually matter — was the one thing never recorded.
That restriction existed because there was nowhere to send production traces;
now there is. An environment opts out by not having keys, and
`LANGFUSE_TRACING_DISABLED=true` is the kill switch for turning it off without
pulling credentials out of Vercel.

Every trace is tagged with:

| Field | Source | Why |
|---|---|---|
| `environment` | `VERCEL_ENV` ?? `NODE_ENV` | Keeps preview noise out of production dashboards |
| `release` | `VERCEL_GIT_COMMIT_SHA` | Pins a regression to a deploy, not a date range |
| `effort_tier`, `effort_model`, `output_effort` | `AnalysisAgent.traceMetadata()` | Answers "which tier ran this turn?" from the trace |
| `turn_timeline` (metadata), `time_to_first_token_ms` / `time_to_first_text_ms` (scores) | `recordTurnTiming` from the chat route's `TurnTimer` | Where a chat turn's time went before the model answered — charted as scores, broken down in the metadata |
| `userId` | `runWithLangfuseUser` (see below) | Groups a trace under the person or key that caused it |
| `workspace_slug` (metadata) | `runWithLangfuseWorkspace` / `runWithLangfuseWorkspaceId` (see below) | Filters traces to one tenant |
| trace name | the root run's `runName`, from `src/lib/langfuseTraceNames.ts` (see below) | Tells a Copilot turn from a bot hand-off from a company card |

`langfuseEnvironment()` normalises the environment name and degrades to
`"default"` on anything Langfuse would reject — an invalid value 400s the whole
ingestion batch, so a junk name must never be forwarded.

### A chat turn's timeline

`POST /api/chat` passes the agent run's root `runId` in the run config: the
question row's id once the question is stored (the id feedback on the reply
scores the trace by, MB-693), otherwise a fresh one. The LangChain handler uses
the root run id as the trace id, so the route knows the trace id before the
run starts and can add to the trace
afterwards. Once the first visible text has streamed (or the turn ends without
any), `recordTurnTiming` upserts the trace with `metadata.turn_timeline` — the
`TurnTimer` stages, cumulative ms from the request: `thread_open`, `context`,
`router`, `memory_recall`, `turn_claimed`, `history_read`, `repairs`,
`model_started`, `first_token`, `first_text`, … — and posts two numeric scores,
`time_to_first_token_ms` and `time_to_first_text_ms`, which the Scores view
can chart per tier, user or release. Langfuse merges a second `trace` event
with the same id, so this adds to the trace the handler created rather than
replacing it. The same timeline is also logged (`[chat] turn … timeline`).

## How a call site gets traced

LangChain and LangGraph call sites merge the handler into their config:

```ts
import { withLangfuseCallbacks } from '@/lib/langfuse';

const res = await llm.invoke(messages, withLangfuseCallbacks({
  timeout: ROUTER_TIMEOUT_MS,
  runName: 'chat.effort_router',
}));
```

Use `withLangfuseCallbacks` rather than spreading `getLangfuseCallbacks()` by
hand. LangChain's `callbacks` is legally a single handler, an array, *or* a
CallbackManager; the hand-rolled `[...(config?.callbacks || [])]` form throws on
the single-handler shape. The helper normalises all three and is a no-op
returning the original config when tracing is off.

Raw Anthropic SDK call sites (the pptx skill and single-slide generation)
cannot use callbacks and build spans by hand with `createPptxTrace` in
`src/lib/pptx/pptxLangfuse.ts`. It gates on the same `isLangfuseEnabled()`.

## What a trace is called

The LangChain handler names a trace after its root run, and an unnamed
`createAgent` graph's root run is called `LangGraph` — so without a name every
agent run lands in Langfuse as the same row. Every `AgentGraph` caller passes a
`runName` from `src/lib/langfuseTraceNames.ts`:

| Name | Run |
|---|---|
| `chat.copilot` | a user's Copilot turn (`/api/chat`) |
| `chat.api` | the external chat API |
| `bots.bot_to_bot` / `bots.bot_to_bot_reply` | a bot answering another bot's @mention / writing up the answers to its own |
| `bots.user_mention`, `bots.routine` | a bot @mentioned by the user in another chat / its routine firing |
| `workforce.company_card`, `workforce.ai_screening`, `workforce.find_partnership_contacts`, `workforce.crm_contact_enrichment`, `workforce.ai_opinion`, `workforce.fund_ai_opinion` | an AI Workforce task, by the queue row's `agent_name` |
| `workforce.insight_refresh`, `workforce.routine`, `workforce.ad_hoc` | any other Workforce run, by how it started (a chat hand-off or a hand-typed task is ad hoc) |
| `jobs.company_analysis`, `jobs.ai_screening`, `jobs.market_screening`, `jobs.track_matching` | the background job handlers |
| `dashboard.daily_pulse`, `chat.memory_import`, `files.extract`, `fund_update.extract` | the remaining agent runs |

Workforce traces also carry `workforce_run_id` and `workforce_agent_name`, and
bot turns `bot_id` / `bot_name`, so runs that share a name can still be told
apart. A new agent entrypoint adds its name there rather than inlining a string.

## Which workspace a trace belongs to

Every trace carries `metadata.workspace_slug`, seeded the same way as the user:
an AsyncLocalStorage in `@/lib/langfuseUser` that `withLangfuseCallbacks` (and
`createPptxTrace`) stamps onto the trace. A request handler reads the slug from
the session's claims (`runWithLangfuseWorkspace(workspaceSlugFromClaims(...))`,
no DB call); background work holding only a workspace id uses
`runWithLangfuseWorkspaceId(db, workspaceId, fn)` from `@/lib/langfuseWorkspace`,
which looks the slug up and caches it per process for five minutes. Seeded at
`/api/chat`, `/api/chat/improve-prompt`, `/api/profile/memories/import`,
`/api/smart-files`, `/api/v1/chat*`, `dispatchJob` (every dispatched job), the
bot-message job, AI Workforce runs and their enqueue-time title, and the daily
pulse. The same wrap-the-work rules as for the user (below) apply.

## Who a trace belongs to

Langfuse's [Users](https://langfuse.com/docs/observability/features/users) view
groups traces, cost and latency by a single `userId` attribute. An entrypoint
declares that id once, and everything it runs inherits it:

```ts
import { runWithLangfuseUser } from '@/lib/langfuseUser';

return runWithLangfuseUser(session.user.id, () => handleChatTurn(req, session, userId));
```

`runWithLangfuseUser` seeds an `AsyncLocalStorage`, and `withLangfuseCallbacks`
reads it back out and stamps it onto the RunnableConfig's `metadata` under the
key `langfuseUserId` — the key the LangChain integration consumes and strips,
turning it into the trace's `userId` attribute. That is why a side call such as
`generateChatTitle` or `routeEffort` is attributed without taking a user
parameter — and it is the reason a call site must use `withLangfuseCallbacks`
rather than dropping `getLangfuseCallbacks()` into a hand-built config, which
carries the handler but not the user.

`createPptxTrace` reads the same store directly (`getLangfuseUserId`), since the
raw SDK takes `userId` on the trace rather than through a RunnableConfig.

| Entrypoint | Filed under |
|---|---|
| Copilot chat (`/api/chat`) | `session.user.id` |
| Prompt improvement (`/api/chat/improve-prompt`) | `session.user.id` |
| Memory import (`/api/profile/memories/import`) | `session.user.id` |
| External chat API (`/api/v1/chat`, `…/stream`) | `api-key:<id>` — `api_keys` rows carry no user, so the key is the principal (`langfuseUserForApiKey`) |
| AI Workforce runs, and the Haiku title generated at enqueue | the queue row's `triggered_by_user_id` |
| Smart Files upload | the uploading user; an internal pipeline upload has no session |
| Cron-triggered routines, daily pulse, background jobs | nothing — there is no user, and inventing one would be worse than an unattributed trace |

Rules when adding an entrypoint:

- Seed it as far out as the identity is known. A streamed turn builds its run
  config deep inside the handler, so wrapping the whole handler is correct;
  wrapping just the `invoke`/`streamEvents` call is enough only when nothing
  else in the handler talks to an LLM.
- **Wrap the work, not just the call that starts it.** The store follows the
  async chain *inside* the scope, so a fire-and-forget promise started in it
  (the chat title) stays attributed after the scope returns — but a stream
  iterator merely *created* in it does not: a `for await` driven from outside
  reads an empty store. Anything that drains a stream, and so runs the tools,
  has to be constructed inside the scope too (`/api/v1/chat/stream`), or
  re-enter it (the Copilot route's SSE `execute`). A `after()` callback never
  inherits — open the scope inside it (`enqueueAgentRun`'s title).
- Pass the id through unguarded. `runWithLangfuseUser(null, fn)` is a no-op, so
  a session-less caller needs no branch of its own. It will not file a trace
  under an empty-string user.
- Namespace a non-human principal (`api-key:<id>`) so it can never collide with
  a `users.id`.
- Import `runWithLangfuseUser` from `@/lib/langfuseUser`. Never re-export it
  through `@/lib/langfuse` — that would put `node:async_hooks` back in reach of
  the workflow bundle (see the module table above).

## What is covered

| Path | Traced via |
|---|---|
| Copilot chat, all agents | `AnalysisAgent.invoke` / `.resume` / `.streamEvents` in `src/lib/agents/analysis/runtime.ts` |
| Sector agents (`minerba`, `dikti`, `bangun`) | Same runtime — `sector/graph.ts` builds on it, there is no second agent runtime |
| Workforce runs | Same runtime, via `src/lib/workforce/runAgent.ts` |
| Background jobs (company analysis, AI screening, market screening, track matching) | Same runtime, via their job handlers |
| File processing | `src/lib/agents/file_processing/index.ts` |
| Fund update processing | `llmExtractor.ts`, `structuredOutput.ts` |
| External chat API (`/api/v1/chat`, `/api/v1/chat/stream`) | Same runtime |
| Chat title, prompt improvement, effort routing, turn wrap-up | `src/lib/chat/*` |
| Workforce run title | `src/lib/workforce/title.ts` |
| Daily pulse | `src/lib/dashboard/dailyPulseNarrator.ts` |
| Presentation generation (pptx skill) | `src/lib/pptx/pptxLangfuse.ts` |
| Single-slide generation | `src/lib/jobs/handlers/slideGeneration.ts`, via the same helper |

## Flushing — the part that is easy to get wrong

Langfuse's callbacks are fire-and-forget. A serverless function can be frozen
with a turn's events still queued, and those traces are simply lost. So every
path that ends a unit of agent work drains the queue:

| Chokepoint | Drains |
|---|---|
| `src/lib/jobs/runner.ts` (`runJob`'s `finally`) | Every background job handler |
| `src/lib/workforce/runAgent.ts` (`invokeAgent`'s `finally` — inside the `'use step'` function, **never** the workflow body) | Workforce runs — WDK workflows, which never pass through `runJob`. The flush must stay in the step: the workflow body runs in the WDK sandbox where Node core modules are unavailable, so bundling the langfuse SDK into it crashes every run |
| `src/app/api/chat/route.ts` (`after()` / `finally`) | Copilot chat turns |
| `src/app/api/v1/chat/route.ts` (`finally`), `…/stream/route.ts` (`after()`) | External chat API |
| `src/lib/dashboard/dailyPulseNarrator.ts` (`finally`) | Daily pulse, from both the route and the session-less cron |
| `processFileContent` / `processFundUpdateContent` wrappers | File + fund-update processing, which `FileService` calls inline from the upload request rather than via `runJob` |
| `improvePrompt`, `generateWorkforceTitle` | One-shot calls whose callers return immediately |

The last three flush inside the leaf helper rather than in the caller. That is
deliberate: those entrypoints have several callers each, and the per-caller
version is exactly the kind of thing a new caller forgets.

A streaming response needs `after()`, not `finally` — `streamEvents` returns the
iterator immediately and the trace events are emitted while the body drains, so
the drain has to outlive the handler.

If you add a new agent entrypoint that is not reached through one of those,
`await flushLangfuse()` in a `finally` before it returns. A `finally` and not a
success path: a HITL pause, a failure, and a re-thrown error should all still
flush what the run produced.

`flushAt` is 1 — one event per request rather than batched — because a dropped
flush in a frozen function otherwise costs the whole trace. This is a
self-hosted instance only this app writes to, so the extra requests are cheap.

## Configuration

```bash
LANGFUSE_SECRET_KEY=sk-lf-...        # both keys present is what enables tracing
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_BASE_URL=https://langfuse-stg.sqe.co.id
LANGFUSE_TRACING_DISABLED=false      # kill switch
```

For staging and production these come from Terraform:

```bash
cd terraform/langfuse && make init-staging
terraform output -raw base_url
terraform output -raw langfuse_public_key
terraform output -raw langfuse_secret_key
```

Locally they match the dummy init values in `docker-compose.yml`.

## Gotchas

- **A trace that never arrives is almost always a missing flush.** Check the
  table above before suspecting the network.
- **A trace that arrives with no user is almost always a missing
  `runWithLangfuseUser`** at a new entrypoint — or a call site that built its
  config by hand around `getLangfuseCallbacks()` instead of going through
  `withLangfuseCallbacks`.
- **A trace named `LangGraph`** is an `AgentGraph` caller that passed no
  `runName` — add one to `src/lib/langfuseTraceNames.ts`.
- **Do not set the Langfuse S3 env vars to empty strings** in the deployment.
  Langfuse falls back to the AWS default credential chain only when they are
  genuinely unset; empty strings are sent as real (invalid) credentials and 403.
- **Model pricing** for cost figures is seeded by `pnpm db:seed:langfuse`
  (`scripts/seed-langfuse-pricing.ts`) against the local instance.
