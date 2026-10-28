import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who the Langfuse traces produced by the current async call chain belong to.
 *
 * Langfuse's `users` feature keys every trace off a single `userId` attribute
 * (https://langfuse.com/docs/observability/features/users). Threading that id
 * through every signature between an entrypoint and an LLM call would mean
 * touching the agent runtime, the chat side-calls (title, effort routing, turn
 * wrap-up), the file/fund-update processors and the pptx helper — and a new
 * call site would silently go unattributed. An AsyncLocalStorage keeps the
 * attribution in one place: seed it once at the entrypoint, and
 * `withLangfuseCallbacks` stamps it onto everything downstream.
 *
 * Same mechanism, and the same verified assumption, as the workforce workspace
 * context in `@/lib/workspace`: the store survives LangChain's `tool()` wrapper
 * and real async hops, not just bare promise chains.
 *
 * ## Why this is its own module
 *
 * It cannot live in `@/lib/langfuse`. `runAgent`'s `'use workflow'` body calls
 * `flushLangfuse`, which puts that module in the WDK workflow bundle, and the
 * bundle rejects every use of a `node:` builtin inside a module it contains —
 * reachable from the workflow body or not. `@/lib/workspace` gets away with the
 * identical import only because nothing but a `'use step'` function imports it.
 *
 * Splitting is not enough on its own: the store is also built lazily, so this
 * module has no import-time side effect and can be shaken back out of any
 * bundle that pulls it in but never reads it.
 */
let langfuseUserContext: AsyncLocalStorage<string> | null = null;

/**
 * Attribute every Langfuse trace produced inside `fn` to `userId`.
 *
 * Call this once per entrypoint, as far out as the identity is known:
 *
 *   - Copilot chat (`/api/chat`) — the session user's id
 *   - External chat API (`/api/v1/chat*`) — `api-key:<id>`, since an API key is
 *     the only principal those requests have
 *   - AI Workforce runs — the queue row's `triggered_by_user_id`
 *   - Smart Files uploads — the uploading user's id
 *
 * A null/blank id is a no-op rather than an error: a cron-triggered routine or
 * a pipeline upload genuinely has no user, and an empty-string `userId` would
 * show up in Langfuse as a real user named "".
 *
 * Wrapping is deliberate over `enterWith`: a streamed chat turn hands back a
 * body that drains after the handler returns, and `run` scopes the store to the
 * work rather than leaving it set on whatever resource the handler ran on. Work
 * that genuinely outlives the handler — the SSE `execute` callback — re-enters
 * instead of relying on inheritance through the stream machinery.
 */
export function runWithLangfuseUser<T>(
  userId: string | null | undefined,
  fn: () => T,
): T {
  const trimmed = userId?.trim();
  if (!trimmed) return fn();
  langfuseUserContext ??= new AsyncLocalStorage<string>();
  return langfuseUserContext.run(trimmed, fn);
}

/** The user the current async context is attributed to, if any. */
export function getLangfuseUserId(): string | undefined {
  // Optional, not `??=`: a read before any entrypoint has seeded the store has
  // nothing to return, and building one to learn that would undo the
  // shake-out this module's laziness exists for.
  return langfuseUserContext?.getStore();
}

/**
 * The workspace the current async context's traces belong to, by slug.
 *
 * Same mechanism, laziness and reasoning as the user store above, and seeded at
 * the same entrypoints: `withLangfuseCallbacks` stamps it onto every trace's
 * metadata as `workspace_slug`, so Langfuse can be filtered to one tenant
 * without threading the workspace through every LLM call site. The slug rather
 * than the id because it is what people read in a `/w/<slug>` URL and what the
 * PostHog events carry (`captureWorkspaceEvent`).
 */
let langfuseWorkspaceContext: AsyncLocalStorage<string> | null = null;

/**
 * File every Langfuse trace produced inside `fn` under workspace `slug`.
 *
 * A null/blank slug is a no-op, as for the user: a caller that could not
 * resolve one (a pipeline job with no workspace) leaves the field off rather
 * than stamping an empty string. Request handlers get the slug from the
 * session's claims (`workspaceSlugFromClaims`); background work resolves it
 * from the row's workspace id with `runWithLangfuseWorkspaceId`.
 */
export function runWithLangfuseWorkspace<T>(
  slug: string | null | undefined,
  fn: () => T,
): T {
  const trimmed = slug?.trim();
  if (!trimmed) return fn();
  langfuseWorkspaceContext ??= new AsyncLocalStorage<string>();
  return langfuseWorkspaceContext.run(trimmed, fn);
}

/** The workspace slug the current async context's traces are filed under, if any. */
export function getLangfuseWorkspaceSlug(): string | undefined {
  return langfuseWorkspaceContext?.getStore();
}
