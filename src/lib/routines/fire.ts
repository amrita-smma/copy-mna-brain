import { RoutinesRepository } from '@/lib/repositories';
import type { DbClient, RoutineRow } from '@/lib/repositories';
import { enqueueAgentRun } from '@/lib/workforce';
import { computeNextFireAt } from './schedule';
import type { ScheduleKind } from './schedule';

const DEFAULT_ROUTINE_AGENT = 'analysis';

export interface FireResult {
  scanned: number;
  fired: Array<{ routineId: string; runId: string; created: boolean }>;
  errors: Array<{ routineId: string; message: string }>;
}

/**
 * Routine firing tick. Called from the per-minute cron route alongside the
 * workforce dispatcher.
 *
 * 1. Claims due routines via `claimDue` (advisory lock + filter on
 *    next_fire_at <= now AND enabled AND not archived).
 * 2. For each, enqueues a workforce run with:
 *      - trigger_source='cron'
 *      - trigger_meta={routine_id, fired_at}
 *      - origin_routine_id=routine.id
 *      - idempotency_key=`routine:${id}:${nextFireAt_iso}` so a retried tick
 *        on the same fire window collapses to one row.
 * 3. Computes the new next_fire_at from the routine's cron expression and
 *    updates last_fired_at + next_fire_at.
 *
 * Failures on one routine don't block the others — errors are collected and
 * the caller logs them.
 */
export async function fireDueRoutines(
  db: DbClient,
  now: Date = new Date(),
): Promise<FireResult> {
  const routinesRepo = new RoutinesRepository(db);
  const due = await routinesRepo.claimDue(now);
  const fired: FireResult['fired'] = [];
  const errors: FireResult['errors'] = [];

  for (const routine of due) {
    try {
      const result = await fireOne(db, routinesRepo, routine, now);
      fired.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      console.error(`[fireDueRoutines] routine ${routine.id} failed:`, err);
      errors.push({ routineId: routine.id, message });
    }
  }

  return { scanned: due.length, fired, errors };
}

async function fireOne(
  db: DbClient,
  routinesRepo: RoutinesRepository,
  routine: RoutineRow,
  now: Date,
): Promise<{ routineId: string; runId: string; created: boolean }> {
  // The fire instant we're crediting this firing to — used as part of the
  // idempotency key so a retry on the same tick collapses to one run.
  const firedAtIso = (routine.next_fire_at ?? now.toISOString());

  const { runId, created } = await enqueueAgentRun(db, {
    agentName: routine.agent_name ?? DEFAULT_ROUTINE_AGENT,
    triggerSource: 'cron',
    triggerMeta: {
      routine_id: routine.id,
      fired_at: firedAtIso,
    },
    input: {
      title: routine.title,
      instruction: routine.prompt,
      prompt: routine.prompt,
    },
    priority: routine.priority,
    originRoutineId: routine.id,
    idempotencyKey: `routine:${routine.id}:${firedAtIso}`,
    triggeredByUserId: null,
  });

  // Advance the schedule. Compute the next fire strictly after the credited
  // fire instant so back-to-back ticks don't re-fire the same window. Pass
  // the schedule kind+spec so monthly clamping (day > daysInMonth → last day)
  // is honored.
  const nextFireAt = computeNextFireAt(
    routine.cron_expression,
    routine.timezone,
    new Date(firedAtIso),
    {
      kind: routine.schedule_kind as ScheduleKind,
      spec: routine.schedule_spec as Record<string, unknown>,
    },
  );
  await routinesRepo.markFired(routine.id, now, nextFireAt);

  return { routineId: routine.id, runId, created };
}
