/**
 * Run context the workforce insight tools read from `configurable` (set by
 * runAgent's toolConfig). These come from the queue row, never from a tool
 * argument, so the model cannot claim to be — or escape — a refresh run.
 */
export interface InsightRunContext {
  runId: string | null;
  refreshInsightId: string | null;
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Non-string or blank values read as null. A refresh insight id without a run
 * id is dropped too: the draft is keyed by the run, so there would be nowhere
 * to write it.
 */
export function readInsightRunContext(
  configurable: Record<string, unknown> | undefined,
): InsightRunContext {
  const runId = readString(configurable?.run_id);
  const refreshInsightId = runId
    ? readString(configurable?.refresh_insight_id)
    : null;
  return { runId, refreshInsightId };
}

/**
 * Returns null when writing to insightId is allowed in the current run;
 * otherwise the rejection to hand the model. A refresh run may only write to
 * the insight it is refreshing.
 */
export function refreshRunWriteRefusal(
  ctx: InsightRunContext,
  insightId: string,
): string | null {
  if (!ctx.refreshInsightId) return null;
  if (ctx.refreshInsightId === insightId.trim()) return null;
  return `Rejection: This run is a scheduled refresh of insight ${ctx.refreshInsightId}; it can only write to that insight.`;
}
