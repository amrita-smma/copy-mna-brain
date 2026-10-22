import type { BotRoutineDto } from '@/lib/bots/routineTypes';
import { BotRoutineValidationError } from '@/lib/services/botRoutineService';
import type { RoutineArgs } from './routineArgs';

/**
 * Shared by the routine tools that touch an existing routine
 * (update_routine, delete_routine): naming one, describing one, and working
 * out the new schedule from a partial change.
 */

/**
 * The routine an argument names: an exact id, else the one routine whose
 * title is exactly that (any case), else the one routine whose title contains
 * it. Null when nothing — or more than one routine — matches, so a vague
 * reference never touches the wrong routine.
 */
export function resolveRoutineRef(routines: readonly BotRoutineDto[], ref: string): BotRoutineDto | null {
  const needle = ref.trim().toLowerCase();
  if (!needle) return null;
  const byId = routines.find((r) => r.id === ref.trim());
  if (byId) return byId;
  const exact = routines.filter((r) => r.title.toLowerCase() === needle);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) return null;
  const partial = routines.filter((r) => r.title.toLowerCase().includes(needle));
  return partial.length === 1 ? partial[0]! : null;
}

/** One routine on a line: its title, schedule, state, next run and id, for the model to read back. */
export function describeRoutine(routine: BotRoutineDto): string {
  const state = routine.enabled ? `next run ${routine.next_fire_at ?? 'unknown'}` : 'paused';
  return `${routine.title} — ${routine.schedule_label}, ${state} (id ${routine.id})`;
}

/** The schedule fields of a routine change; `schedule` may be left out to keep the routine's kind. */
export type ScheduleChange = Partial<Pick<RoutineArgs, 'schedule' | 'time' | 'weekdays' | 'day_of_month' | 'cron' | 'timezone'>>;

/** Whether any schedule field was given at all. */
export function hasScheduleChange(change: ScheduleChange): boolean {
  return (
    change.schedule !== undefined ||
    change.time !== undefined ||
    change.weekdays !== undefined ||
    change.day_of_month !== undefined ||
    change.cron !== undefined ||
    change.timezone !== undefined
  );
}

/** The detail fields each schedule kind reads; anything else given would be silently dropped by the service. */
const DETAILS_BY_KIND: Record<RoutineArgs['schedule'], readonly (keyof ScheduleChange)[]> = {
  daily: ['time'],
  weekly: ['time', 'weekdays'],
  monthly: ['time', 'day_of_month'],
  cron: ['cron'],
};

/**
 * The schedule patch for the routines service from a partial change: the
 * kind given (or cron, when a cron expression is given without a kind), else
 * the routine's own; the details given laid over the routine's own when the
 * kind is unchanged (so "move it to 10:00" keeps the weekdays), or over just
 * its time of day when switching between daily, weekly and monthly (so "make
 * it weekly on Mondays" keeps the hour); the timezone given or the routine's
 * own. A detail the resulting kind does not read (weekdays on a daily
 * routine, a time on a cron one) is refused rather than dropped. The service
 * validates the result, so a weekly routine with no weekdays is refused
 * there.
 */
export function schedulePatch(
  existing: Pick<BotRoutineDto, 'schedule_kind' | 'schedule_spec' | 'timezone'>,
  change: ScheduleChange,
): { schedule_kind: RoutineArgs['schedule']; schedule_spec: Record<string, unknown>; timezone: string } {
  const kind = change.schedule ?? (change.cron !== undefined ? 'cron' : existing.schedule_kind);
  const stray = (['time', 'weekdays', 'day_of_month', 'cron'] as const).filter(
    (field) => change[field] !== undefined && !DETAILS_BY_KIND[kind].includes(field),
  );
  if (stray.length > 0) {
    throw new BotRoutineValidationError(
      `${stray.join(', ')} does not apply to a ${kind} routine (it takes ${DETAILS_BY_KIND[kind].join(' and ')}); pass schedule to change the kind`,
    );
  }
  const given: Record<string, unknown> = {};
  if (change.time !== undefined) given.time = change.time;
  if (change.weekdays !== undefined) given.weekdays = change.weekdays;
  if (change.day_of_month !== undefined) given.day = change.day_of_month;
  if (change.cron !== undefined) given.expression = change.cron;
  let base: Record<string, unknown> = {};
  if (kind === existing.schedule_kind) base = existing.schedule_spec;
  else if (kind !== 'cron' && existing.schedule_kind !== 'cron' && existing.schedule_spec.time !== undefined) {
    base = { time: existing.schedule_spec.time };
  }
  return { schedule_kind: kind, schedule_spec: { ...base, ...given }, timezone: change.timezone ?? existing.timezone };
}
