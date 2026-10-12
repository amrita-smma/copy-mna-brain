import { CallbackHandler } from "langfuse-langchain";

/**
 * The Langfuse gate and the client behind it: whether to trace, which
 * environment a trace is filed under, the shared callback handler, and the
 * queue drain.
 *
 * Tracing is on wherever a Langfuse project key pair is configured. That is the
 * whole point of the self-hosted instance in `terraform/langfuse`: traces from
 * staging and production are the ones worth having, and withholding them was
 * only ever a stand-in for "we have nowhere safe to send them". The two ways to
 * turn it off are to leave the keys unset (which is what any environment
 * without a Langfuse deployment does) or to set `LANGFUSE_TRACING_DISABLED=true`
 * as a kill switch.
 *
 * ## Why this is split from `@/lib/langfuse`
 *
 * Call sites import `@/lib/langfuse`, which re-exports everything here — with
 * one exception that is load-bearing. `runAgent`'s `'use workflow'` body drains
 * the queue in its `finally`, and a WDK workflow bundle rejects every use of a
 * `node:` builtin inside any module it contains. `@/lib/langfuse` reaches the
 * AsyncLocalStorage in `@/lib/langfuseUser`, so it cannot be what that `finally`
 * imports. This module has no Node builtins and is safe there.
 *
 * Keep it that way: nothing here may import `@/lib/langfuseUser`, directly or
 * transitively, or the workflow build fails with
 * `workflow-node-module-error`.
 */

type LangfuseEnv = Partial<
  Record<
    | "NODE_ENV"
    | "VERCEL_ENV"
    | "LANGFUSE_SECRET_KEY"
    | "LANGFUSE_PUBLIC_KEY"
    | "LANGFUSE_BASE_URL"
    | "LANGFUSE_TRACING_DISABLED"
    | "VERCEL_GIT_COMMIT_SHA",
    string
  >
>;

let langfuseHandler: CallbackHandler | null = null;

export function isLangfuseEnabled(env: LangfuseEnv = process.env): boolean {
  if (env.LANGFUSE_TRACING_DISABLED === "true") return false;
  // Both keys, not just the secret: Langfuse authenticates ingestion with the
  // pair, so a half-configured environment would emit traces that are rejected
  // at the far end with nothing failing locally to say so.
  return Boolean(env.LANGFUSE_SECRET_KEY && env.LANGFUSE_PUBLIC_KEY);
}

/**
 * Which Langfuse environment a trace is filed under. Langfuse accepts a
 * lowercase alphanumeric string with hyphens and underscores that does not
 * start with `langfuse`, and uses `default` as its own fallback for an unset
 * value — so an unrecognised input degrades to that rather than making the
 * whole ingestion batch 400.
 */
export function langfuseEnvironment(env: LangfuseEnv = process.env): string {
  const candidate = env.VERCEL_ENV ?? env.NODE_ENV;
  if (!candidate) return "default";
  const normalized = candidate.toLowerCase();
  if (normalized.startsWith("langfuse")) return "default";
  return /^[a-z0-9_-]+$/.test(normalized) ? normalized : "default";
}

/**
 * Traces are flushed explicitly at the end of a turn (see `flushLangfuse`), but
 * serverless functions can be frozen before a background timer runs. Batching
 * one event at a time keeps a dropped flush from costing the whole trace, at
 * the price of more requests — acceptable for a self-hosted instance that only
 * this app writes to.
 */
const FLUSH_AT = 1;

export function getLangfuseCallbacks() {
  if (!isLangfuseEnabled()) return [];

  if (!langfuseHandler) {
    langfuseHandler = new CallbackHandler({
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL || "http://langfuse-web:3000",
      environment: langfuseEnvironment(),
      // Lets a regression be pinned to a deploy instead of a date range.
      release: process.env.VERCEL_GIT_COMMIT_SHA,
      flushAt: FLUSH_AT,
    });
  }
  return [langfuseHandler];
}

/** Drain the Langfuse queue — call after streamed chat turns so events aren't dropped. */
export async function flushLangfuse(): Promise<void> {
  if (!langfuseHandler) return;
  try {
    await langfuseHandler.flushAsync();
  } catch (err) {
    console.warn("[langfuse] flush failed", err);
  }
}

/** Test seam: drop the memoized handler so the next call re-reads the env. */
export function resetLangfuseHandlerForTests(): void {
  langfuseHandler = null;
}
