import { computeNextFireAt, normalizeSchedule } from '@/lib/routines';
import type { ScheduleKind } from '@/lib/routines';
import type { RoutineInsert, RoutinesRepository } from '@/lib/repositories';

// Fixed id so the permanent market-scanning routine is a singleton: every sync
// targets the same row rather than spawning duplicates.
export const MARKET_SCANNING_ROUTINE_ID =
  '00000000-0000-0000-0000-000000000001';

const ROUTINE_AGENT = 'analysis';
// WIB (West Indonesia Time, UTC+7). The scan fires at 12am WIB, so the schedule
// is computed in this timezone rather than UTC.
const ROUTINE_TIMEZONE = 'Asia/Jakarta';
const ROUTINE_TITLE = 'Market Scanning';
const ROUTINE_PROMPT =
  'Run the market scan to discover new acquisition targets. Use the run_market_screening tool to search the web for companies matching our current active investment thesis and add any new targets to the pipeline.';

// Time-of-day for the scan, interpreted in ROUTINE_TIMEZONE. The thesis carries
// the cadence (scan_frequency) but not a fire time, so we fix it at 12am WIB
// and let the cadence drive the rest (weekday for weekly, day-of-month for
// monthly).
const SCAN_TIME = '00:00';

/**
 * Map the thesis `scan_frequency` (daily | weekly | monthly) onto a routine
 * schedule. Unknown/empty values fall back to weekly — the same default the
 * thesis column carries.
 */
function frequencyToSchedule(frequency: string): {
  kind: ScheduleKind;
  spec: Record<string, unknown>;
} {
  switch (frequency) {
    case 'daily':
      return { kind: 'daily', spec: { time: SCAN_TIME } };
    case 'monthly':
      return { kind: 'monthly', spec: { time: SCAN_TIME, day: 1 } };
    case 'weekly':
    default:
      return { kind: 'weekly', spec: { time: SCAN_TIME, weekdays: [1] } };
  }
}

/**
 * Keeps the permanent market-scanning routine in lockstep with the active
 * investment thesis.
 *
 * The thesis owns the cadence (`scan_frequency`) and the number of companies
 * per scan (`sources_count`). This service maps the cadence onto the routine's
 * schedule so the cron worker fires the scan at the right interval. The
 * company count is NOT encoded on the routine — the `run_market_screening`
 * tool reads it straight from the active thesis at fire time, so a single
 * source of truth drives both the schedule and the scan size.
 */
export class MarketScanningRoutineService {
  constructor(private readonly routinesRepo: RoutinesRepository) {}

  async sync(scanFrequency: string | null | undefined): Promise<void> {
    const { kind, spec } = frequencyToSchedule(scanFrequency ?? 'weekly');
    const { cronExpression, scheduleSpec } = normalizeSchedule(kind, spec);
    const nextFireAt = computeNextFireAt(
      cronExpression,
      ROUTINE_TIMEZONE,
      new Date(),
      { kind, spec: scheduleSpec },
    );

    const existing = await this.routinesRepo.findById(
      MARKET_SCANNING_ROUTINE_ID,
    );
    if (existing) {
      await this.routinesRepo.update(MARKET_SCANNING_ROUTINE_ID, {
        schedule_kind: kind,
        schedule_spec: scheduleSpec,
        cron_expression: cronExpression,
        next_fire_at: nextFireAt,
      });
      return;
    }

    await this.routinesRepo.create({
      id: MARKET_SCANNING_ROUTINE_ID,
      title: ROUTINE_TITLE,
      prompt: ROUTINE_PROMPT,
      schedule_kind: kind,
      schedule_spec: scheduleSpec,
      cron_expression: cronExpression,
      timezone: ROUTINE_TIMEZONE,
      agent_name: ROUTINE_AGENT,
      priority: 0,
      enabled: true,
      is_system: true,
      next_fire_at: nextFireAt,
      created_by: null,
    } as RoutineInsert);
  }
}
