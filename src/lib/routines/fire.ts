import { RoutinesRepository } from '@/lib/repositories';
import { getActiveWorkspaceId, runWithWorkforceWorkspaceId } from '@/lib/workspace';
import type { DbClient, RoutineRow } from '@/lib/repositories';
import { enqueueAgentRun } from '@/lib/workforce';
import { computeNextFireAt } from './schedule';
import type { ScheduleKind } from './schedule';
import { buildRoutineRunPayload } from './runPayload';
import { listDeprecatedSectorAgentKeys, resolveRefreshAgentKey } from './refreshAgent';

const DEFAULT_ROUTINE_AGENT = 'analysis';

export interface FireResult {
  scanned: number;
  /** Routines paused this tick because their insight's agent is deprecated. */
  pausedForDeprecatedAgent: string[];
  fired: Array<{ routineId: string; runId: string; created: boolean }>;
  skipped: Array<{ routineId: string; reason: string }>;
  errors: Array<{ routineId: string; message: string }>;
}

export interface FireDueRoutinesOptions {
  /**
   * The registry keys deprecated in this release. Injectable so tests can
   * supply a fixture while the shipped registry has no deprecated agent.
   */
  deprecatedAgentKeys?: () => string[];
}

/**
 * Routine firing tick. Called from the per-minute cron route alongside the
 * workforce dispatcher.
 *
 * 0. Pauses (one set-based UPDATE) every enabled insight refresh routine whose
 *    insight is bound to a deprecated agent (MB-560). Deprecation ships in a
 *    release, so there is no event to react to; sweeping every tick pauses
 *    those schedules on the first tick after the deploy rather than at their
 *    next fire time, and running it before claimDue means a just-paused
 *    routine never fires.
 * 1. Claims due routines via `claimDue` (advisory lock + filter on
 *    next_fire_at <= now AND enabled AND not archived).
 * 2. Looks up refresh targets for any routines tied to an insight. If an
 *    insight is archived, the routine is paused, skipped, and not enqueued.
 * 3. Looks up (in one query) which due routines still have a run that hasn't
 *    finished — e.g. a refresh waiting on its owner's answer (MB-561). Those
 *    are skipped rather than stacking a second run, and their next_fire_at is
 *    advanced so they don't come due again on every tick.
 * 4. For each remaining routine, enqueues a workforce run with:
 *      - trigger_source='cron'
 *      - trigger_meta={routine_id, fired_at, insight_id?}
 *      - input.agent_key for a refresh run: the insight's bound sector agent
 *        or 'general', resolved now so a later rebind applies from the next
 *        run and never mid-run
 *      - origin_routine_id=routine.id
 *      - idempotency_key=`routine:${id}:${nextFireAt_iso}` so a retried tick
 *        on the same fire window collapses to one row.
 * 5. Computes the new next_fire_at from the routine's cron expression and
 *    updates last_fired_at + next_fire_at.
 *
 * Failures on one routine don't block the others — errors are collected and
 * the caller logs them.
 */
export async function fireDueRoutines(
  db: DbClient,
  now: Date = new Date(),
  options: FireDueRoutinesOptions = {},
): Promise<FireResult> {
  const routinesRepo = new RoutinesRepository(db, await getActiveWorkspaceId());
  const pausedForDeprecatedAgent = await pauseDeprecatedAgentRoutines(
    routinesRepo,
    options.deprecatedAgentKeys ?? listDeprecatedSectorAgentKeys,
  );
  const due = await routinesRepo.claimDue(now);
  const fired: FireResult['fired'] = [];
  const skipped: FireResult['skipped'] = [];
  const errors: FireResult['errors'] = [];

  const insightIds = [
    ...new Set(
      due
        .map((r) => r.insight_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const insightTargets = await routinesRepo.findInsightRefreshTargetsByIds(insightIds);
  const routinesWithActiveRun = await routinesRepo.findActiveRunRoutineIds(
    due.map((r) => r.id),
  );

  for (const routine of due) {
    try {
      const target = routine.insight_id
        ? insightTargets.get(routine.insight_id)
        : undefined;

      if (routine.insight_id && target?.archived) {
        await routinesRepo.pause(routine.id);
        console.warn(
          `[fireDueRoutines] routine ${routine.id} (insight ${routine.insight_id}): insight is archived; routine paused`,
        );
        skipped.push({
          routineId: routine.id,
          reason: 'insight is archived; routine paused',
        });
        continue;
      }

      if (routinesWithActiveRun.has(routine.id)) {
        const nextFireAt = nextFireAfterCredit(routine, now);
        await routinesRepo.advanceSchedule(routine.id, nextFireAt);
        const reason = 'previous run still active; not stacking another run';
        console.warn(
          `[fireDueRoutines] routine ${routine.id}: ${reason}; next fire ${nextFireAt}`,
        );
        skipped.push({ routineId: routine.id, reason });
        continue;
      }

      const insightName = target ? target.name : null;
      const agentKey = routine.insight_id
        ? resolveRefreshAgentKey(target?.agentKey)
        : null;
      const fireFn = () =>
        fireOne(db, routinesRepo, routine, now, insightName, agentKey);
      // The cron tick has no request, so enqueueAgentRun falls back to the
      // legacy MNA workspace unless wrapped in the routine's own workspace.
      const result = routine.workspace_id
        ? await runWithWorkforceWorkspaceId(routine.workspace_id, fireFn)
        : await fireFn();
      fired.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      console.error(`[fireDueRoutines] routine ${routine.id} failed:`, err);
      errors.push({ routineId: routine.id, message });
    }
  }

  return { scanned: due.length, pausedForDeprecatedAgent, fired, skipped, errors };
}

// A failed sweep must not stop the tick: the cron route runs this before the
// workforce dispatcher, so a throw here would stall dispatch for every
// workspace. The sweep runs again on the next tick.
async function pauseDeprecatedAgentRoutines(
  routinesRepo: RoutinesRepository,
  deprecatedAgentKeys: () => string[],
): Promise<string[]> {
  try {
    const paused = await routinesRepo.pauseForDeprecatedAgents(deprecatedAgentKeys());
    if (paused.length > 0) {
      console.warn(
        `[fireDueRoutines] paused ${paused.length} routine(s) bound to a deprecated agent: ${paused.join(', ')}`,
      );
    }
    return paused;
  } catch (err) {
    console.error('[fireDueRoutines] deprecated-agent sweep failed:', err);
    return [];
  }
}

async function fireOne(
  db: DbClient,
  routinesRepo: RoutinesRepository,
  routine: RoutineRow,
  now: Date,
  insightName: string | null,
  agentKey: string | null,
): Promise<{ routineId: string; runId: string; created: boolean }> {
  // The fire instant we're crediting this firing to — used as part of the
  // idempotency key so a retry on the same tick collapses to one run.
  const firedAtIso = (routine.next_fire_at ?? now.toISOString());

  const { triggerMeta, input } = buildRoutineRunPayload(routine, {
    insightName,
    agentKey,
    baseTriggerMeta: {
      routine_id: routine.id,
      fired_at: firedAtIso,
    },
  });

  const { runId, created } = await enqueueAgentRun(db, {
    agentName: routine.agent_name ?? DEFAULT_ROUTINE_AGENT,
    triggerSource: 'cron',
    triggerMeta,
    input,
    priority: routine.priority,
    originRoutineId: routine.id,
    idempotencyKey: `routine:${routine.id}:${firedAtIso}`,
    triggeredByUserId: null,
  });

  await routinesRepo.markFired(routine.id, now, nextFireAfterCredit(routine, now));

  return { routineId: routine.id, runId, created };
}

// Advance the schedule. Compute the next fire strictly after the credited
// fire instant (the routine's due next_fire_at) so back-to-back ticks don't
// re-fire the same window. Pass the schedule kind+spec so monthly clamping
// (day > daysInMonth → last day) is honored.
function nextFireAfterCredit(routine: RoutineRow, now: Date): string {
  const firedAtIso = routine.next_fire_at ?? now.toISOString();
  return computeNextFireAt(
    routine.cron_expression,
    routine.timezone,
    new Date(firedAtIso),
    {
      kind: routine.schedule_kind as ScheduleKind,
      spec: routine.schedule_spec as Record<string, unknown>,
    },
  );
}
