/** Final-message prefix AnalysisAgent.invoke returns when the graph call threw. */
export const AGENT_INVOKE_ERROR_PREFIX = 'Error invoking agent:';

// Trace plumbing the agent attaches to every turn, including the closing one.
// Neither does any work, so a turn carrying only these has nothing left to run.
const PLUMBING_TOOLS = new Set(['narrate_step', 'report_progress']);

/**
 * True when `finalMessage` is the swallowed form of the graph's step limit.
 * `AnalysisAgent.invoke` catches every error, `GraphRecursionError` included,
 * and hands it back as `Error invoking agent: Recursion limit of N reached…`.
 */
export function isSwallowedRecursionError(finalMessage: string): boolean {
  const text = finalMessage.trim();
  return text.startsWith(AGENT_INVOKE_ERROR_PREFIX) && /recursion limit/i.test(text);
}

/**
 * The agent's own closing report, when the step limit cut the run off only
 * after the agent had finished.
 *
 * The closing turn carries a `narrate_step` call next to its "✓ Done:" report,
 * so the graph still owes a tools superstep and a model superstep after it. A
 * run that spent its last superstep on the report hits the limit right there:
 * every write has landed and the report is in the checkpoint, yet the run would
 * be failed for it. Reads the checkpointed thread and returns that report, or
 * null when the thread does not end on one (the limit hit mid-work, so the
 * failure is real).
 */
export function finishedReportFromThread<M>(
  messages: readonly M[],
  extractText: (message: M) => string,
): string | null {
  const last = messages[messages.length - 1];
  if (!last) return null;

  const toolCalls = (last as { tool_calls?: unknown }).tool_calls;
  const calls = Array.isArray(toolCalls) ? toolCalls : [];
  const hasRealToolCall = calls.some((call) => {
    const name = (call as { name?: unknown } | null)?.name;
    return typeof name !== 'string' || !PLUMBING_TOOLS.has(name);
  });
  if (hasRealToolCall) return null;

  const text = extractText(last);
  return /^\s*[✓✔]\s*Done:/m.test(text) ? text : null;
}
