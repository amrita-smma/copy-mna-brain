/**
 * Keeps an AI Screening Workforce task from moving the deal itself.
 *
 * An `ai_screening` task runs on the general Workforce agent, which also holds
 * `move_stage` and `drop_company`. Whether a screened
 * Pending Confirmation company is promoted or dropped is decided only by
 * `run_ai_screening` (`PendingAutoScanService.processCompany`), which honours
 * the workspace's Auto promote / Auto drop toggles. Without this guard the
 * model could read "Passed; auto promote is off, left pending" and promote the
 * company anyway, ignoring the toggle.
 *
 * Dependency-free: `runAgent` puts the queue row's `agent_name` on the tool
 * config, and the write tools check it here.
 */

/** Queue `agent_name` of the per-company AI screening task (`AIScreeningService`). */
export const AI_SCREENING_AGENT_NAME = 'ai_screening';

type ToolRuntime = { configurable?: Record<string, unknown> } | undefined;

/** True when the tool is running inside an `ai_screening` Workforce task. */
export function isAiScreeningRun(runtime: ToolRuntime): boolean {
  return runtime?.configurable?.agent_name === AI_SCREENING_AGENT_NAME;
}

/**
 * The refusal a promote/drop tool returns inside an AI Screening task, or
 * `null` when the call may go ahead.
 */
export function screeningRunWriteRefusal(runtime: ToolRuntime, action: string): string | null {
  if (!isAiScreeningRun(runtime)) return null;
  return (
    `**Refused:** ${action} is not allowed in an AI Screening task. Whether a screened ` +
    'company is promoted or dropped is decided by run_ai_screening alone, following the ' +
    "workspace's Auto promote / Auto drop toggles. Leave the company where it is and report " +
    'what run_ai_screening did.'
  );
}
