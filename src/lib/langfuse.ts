import { CallbackHandler } from "langfuse-langchain";

/**
 * Single gate for Langfuse tracing across every agent path.
 *
 * Tracing is on wherever a Langfuse project key pair is configured. That is the
 * whole point of the self-hosted instance in `terraform/langfuse`: traces from
 * staging and production are the ones worth having, and withholding them was
 * only ever a stand-in for "we have nowhere safe to send them". The two ways to
 * turn it off are to leave the keys unset (which is what any environment
 * without a Langfuse deployment does) or to set `LANGFUSE_TRACING_DISABLED=true`
 * as a kill switch.
 *
 * Callbacks go in the `callbacks` array of a LangChain/LangGraph invocation.
 * Raw Anthropic SDK call sites use `@/lib/pptx/pptxLangfuse` instead, which
 * gates on this same function.
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

/**
 * Merge Langfuse callbacks into an existing LangChain `RunnableConfig` without
 * dropping callbacks the caller already set.
 *
 * Every agent call site should route through this rather than hand-rolling the
 * spread: `callbacks` is legally a single handler, an array, or a
 * CallbackManager, and the hand-rolled `[...(config?.callbacks || [])]` form
 * silently discards a non-array value.
 */
export function withLangfuseCallbacks<T extends Record<string, unknown>>(
  config?: T,
): T | (T & { callbacks: unknown[] }) {
  const base = config ?? ({} as T);
  const handlers = getLangfuseCallbacks();
  if (handlers.length === 0) return base;

  const incoming = (base as { callbacks?: unknown }).callbacks;

  // A CallbackManager is not an array and must not be wrapped in one — LangChain
  // types `callbacks` as `CallbackManager | BaseCallbackHandler[]`, so an array
  // containing a manager is neither. Copy it and register the handler, which is
  // the manager's own merge path.
  if (isCallbackManager(incoming)) {
    const manager = incoming.copy();
    for (const handler of handlers) manager.addHandler(handler, true);
    return { ...base, callbacks: manager as unknown as unknown[] };
  }

  const existing = Array.isArray(incoming)
    ? incoming
    : incoming
      ? [incoming]
      : [];

  return { ...base, callbacks: [...existing, ...handlers] };
}

type CallbackManagerLike = {
  copy: () => CallbackManagerLike;
  addHandler: (handler: unknown, inherit?: boolean) => void;
};

function isCallbackManager(value: unknown): value is CallbackManagerLike {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as CallbackManagerLike).copy === "function" &&
    typeof (value as CallbackManagerLike).addHandler === "function"
  );
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
