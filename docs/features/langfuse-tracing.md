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

## The gate

`src/lib/langfuse.ts` is the only place that decides whether to trace:

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

`langfuseEnvironment()` normalises the environment name and degrades to
`"default"` on anything Langfuse would reject — an invalid value 400s the whole
ingestion batch, so a junk name must never be forwarded.

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
| `src/lib/workforce/runAgent.ts` (`finally`) | Workforce runs — WDK workflows, which never pass through `runJob` |
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
- **Do not set the Langfuse S3 env vars to empty strings** in the deployment.
  Langfuse falls back to the AWS default credential chain only when they are
  genuinely unset; empty strings are sent as real (invalid) credentials and 403.
- **Model pricing** for cost figures is seeded by `pnpm db:seed:langfuse`
  (`scripts/seed-langfuse-pricing.ts`) against the local instance.
