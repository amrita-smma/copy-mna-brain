import { start } from 'workflow/api';
import { runAgent } from './runAgent';

/**
 * Trigger the durable Vercel Workflow for a claimed queue row (MB-147 Tier 2).
 *
 * Called by the dispatcher after it atomically claims a row (status flips
 * pending/resume_ready → running). Returns immediately — start() enqueues the
 * workflow execution and the WDK runtime takes it from there.
 *
 * Idempotency:
 *   The dispatcher's atomic claim is the source of truth for "should this
 *   workflow start." Because at most one caller can successfully claim a
 *   given row (advisory lock + status predicate), at most one start() is
 *   issued per row in the happy path. If a second start() somehow fires for
 *   the same runId (e.g. a manual ops trigger), the workflow's first step
 *   (loadAndHeartbeat) will see status != 'running' and throw — guarding
 *   against double-execution at the agent level.
 *
 * Tier 1 behavior (stub) was to console.log only. Tier 2 actually launches
 * the workflow via WDK.
 */
export async function triggerWorkflowForRun(runId: string): Promise<void> {
  await start(runAgent, [{ runId }]);
}
