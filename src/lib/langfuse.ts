import { getLangfuseCallbacks } from "./langfuseClient";
import { getLangfuseUserId } from "./langfuseUser";

/**
 * Single gate for Langfuse tracing across every agent path — this is the module
 * call sites import.
 *
 * Whether to trace at all, and the handler itself, live in
 * `@/lib/langfuseClient`, which this re-exports. Whoever a run belongs to lives
 * in `@/lib/langfuseUser`. What is here is the one place those two meet:
 * building the LangChain `RunnableConfig` that carries both.
 *
 * Callbacks go in the `callbacks` array of a LangChain/LangGraph invocation.
 * Raw Anthropic SDK call sites use `@/lib/pptx/pptxLangfuse` instead, which
 * gates on the same `isLangfuseEnabled`.
 *
 * One caller must NOT come through here: a WDK `'use workflow'` body, which
 * cannot contain a `node:` builtin and so cannot reach `@/lib/langfuseUser`.
 * `runAgent`'s drain imports `flushLangfuse` from `@/lib/langfuseClient`
 * directly for that reason.
 */

export {
  flushLangfuse,
  getLangfuseCallbacks,
  isLangfuseEnabled,
  langfuseEnvironment,
  resetLangfuseHandlerForTests,
} from "./langfuseClient";

/**
 * The metadata key Langfuse's LangChain integration reads a trace's user from.
 * It is consumed and stripped by the callback handler, so it never shows up as
 * a stray metadata field on the trace.
 */
const LANGFUSE_USER_METADATA_KEY = "langfuseUserId";

/**
 * Stamp the ambient user onto a RunnableConfig's `metadata`.
 *
 * An explicit `langfuseUserId` from the call site wins — a caller that knows
 * better than the ambient context (say, a run executing work on someone else's
 * behalf) should not have it overwritten.
 */
function withLangfuseUserMetadata<T extends Record<string, unknown>>(
  config: T,
): T {
  const userId = getLangfuseUserId();
  if (!userId) return config;

  const incoming = (config as { metadata?: unknown }).metadata;
  const existing =
    typeof incoming === "object" && incoming !== null && !Array.isArray(incoming)
      ? (incoming as Record<string, unknown>)
      : undefined;
  if (existing?.[LANGFUSE_USER_METADATA_KEY]) return config;

  return {
    ...config,
    metadata: { ...(existing ?? {}), [LANGFUSE_USER_METADATA_KEY]: userId },
  };
}

/**
 * Merge Langfuse callbacks into an existing LangChain `RunnableConfig` without
 * dropping callbacks the caller already set.
 *
 * Every agent call site should route through this rather than hand-rolling the
 * spread: `callbacks` is legally a single handler, an array, or a
 * CallbackManager, and the hand-rolled `[...(config?.callbacks || [])]` form
 * silently discards a non-array value.
 *
 * Also stamps the ambient `runWithLangfuseUser` id into `metadata`, which is
 * the whole reason a call site gets user attribution for free. Callers that
 * build a config by hand and pass `getLangfuseCallbacks()` straight into it
 * bypass that — use this helper instead.
 */
export function withLangfuseCallbacks<T extends Record<string, unknown>>(
  config?: T,
): T | (T & { callbacks: unknown[] }) {
  const handlers = getLangfuseCallbacks();
  if (handlers.length === 0) return config ?? ({} as T);

  const base = withLangfuseUserMetadata(config ?? ({} as T));
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
