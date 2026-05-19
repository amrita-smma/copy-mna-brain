import { CronExpressionParser } from 'cron-parser';

export type ScheduleKind = 'daily' | 'weekly' | 'monthly' | 'cron';

export interface DailySpec {
  // "HH:MM" in 24h, interpreted in the routine's timezone.
  time: string;
}

export interface WeeklySpec {
  time: string;
  // 0=Sun … 6=Sat, matching cron's day-of-week.
  weekdays: number[];
}

export interface MonthlySpec {
  time: string;
  // 1..31 — values >28 may skip months that don't have that day.
  day: number;
}

export interface CronSpec {
  expression: string;
}

export type ScheduleSpec = DailySpec | WeeklySpec | MonthlySpec | CronSpec;

export interface NormalizedSchedule {
  cronExpression: string;
  scheduleSpec: Record<string, unknown>;
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;

function parseTime(time: string): { hour: number; minute: number } {
  const m = HHMM.exec(time);
  if (!m) throw new Error(`Invalid time "${time}", expected HH:MM`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/**
 * Convert a (kind, spec) pair to a canonical 5-field cron expression. The
 * derived expression is then stored on the routine alongside the spec; the
 * dispatcher only reads `cron_expression` + `timezone` to compute next fires.
 *
 * The cron form is intentionally minute-granular (5 fields, not 6). cron-parser
 * accepts 5 fields and assumes seconds=0, which matches the dispatcher's
 * minute-tick cadence.
 */
export function normalizeSchedule(
  kind: ScheduleKind,
  spec: unknown,
): NormalizedSchedule {
  switch (kind) {
    case 'daily': {
      const { time } = spec as DailySpec;
      const { hour, minute } = parseTime(time);
      return {
        cronExpression: `${minute} ${hour} * * *`,
        scheduleSpec: { time },
      };
    }
    case 'weekly': {
      const { time, weekdays } = spec as WeeklySpec;
      if (!Array.isArray(weekdays) || weekdays.length === 0) {
        throw new Error('weekly schedule requires non-empty weekdays array');
      }
      const normalized = [...new Set(weekdays)].sort((a, b) => a - b);
      for (const d of normalized) {
        if (!Number.isInteger(d) || d < 0 || d > 6) {
          throw new Error(`Invalid weekday ${d}, expected 0..6`);
        }
      }
      const { hour, minute } = parseTime(time);
      return {
        cronExpression: `${minute} ${hour} * * ${normalized.join(',')}`,
        scheduleSpec: { time, weekdays: normalized },
      };
    }
    case 'monthly': {
      const { time, day } = spec as MonthlySpec;
      if (!Number.isInteger(day) || day < 1 || day > 31) {
        throw new Error(`Invalid day-of-month ${day}, expected 1..31`);
      }
      const { hour, minute } = parseTime(time);
      return {
        cronExpression: `${minute} ${hour} ${day} * *`,
        scheduleSpec: { time, day },
      };
    }
    case 'cron': {
      const { expression } = spec as CronSpec;
      if (typeof expression !== 'string' || expression.trim().split(/\s+/).length !== 5) {
        throw new Error('cron schedule requires a 5-field expression');
      }
      // Validate by parsing; throws if invalid.
      CronExpressionParser.parse(expression);
      return {
        cronExpression: expression.trim(),
        scheduleSpec: { expression: expression.trim() },
      };
    }
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown schedule kind: ${String(exhaustive)}`);
    }
  }
}

/**
 * Compute the next time the cron expression fires, strictly after `from`,
 * interpreted in the given timezone. Returns an ISO timestamp (UTC) suitable
 * for storing in `routines.next_fire_at`.
 */
export function computeNextFireAt(
  cronExpression: string,
  timezone: string,
  from: Date = new Date(),
): string {
  const it = CronExpressionParser.parse(cronExpression, {
    currentDate: from,
    tz: timezone,
  });
  const next = it.next();
  return next.toDate().toISOString();
}
