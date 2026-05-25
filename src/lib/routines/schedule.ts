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
  // 1..31. Values that exceed a given month's last day fire on the last day
  // of that month instead (e.g. day=31 fires on Feb 28/29, Apr 30, etc.). This
  // clamp is applied by computeNextFireAt; the stored cron expression is the
  // literal `day` so consumers that read cron_expression alone still see the
  // user's intent.
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
 *
 * When `schedule.kind === 'monthly'`, monthly clamping is applied: a `day`
 * that exceeds a given month's last day fires on the last day of that month
 * instead of skipping the month. Standard cron has no way to express this, so
 * the monthly branch bypasses cron-parser entirely.
 */
export function computeNextFireAt(
  cronExpression: string,
  timezone: string,
  from: Date = new Date(),
  schedule?: { kind: ScheduleKind; spec: Record<string, unknown> },
): string {
  if (schedule?.kind === 'monthly') {
    const { time, day } = schedule.spec as unknown as MonthlySpec;
    const { hour, minute } = parseTime(time);
    return computeNextMonthlyFire(day, hour, minute, timezone, from);
  }
  const it = CronExpressionParser.parse(cronExpression, {
    currentDate: from,
    tz: timezone,
  });
  const next = it.next();
  return next.toDate().toISOString();
}

/**
 * Walk forward month-by-month from `from` (in `timezone`) and return the first
 * fire instant > from. If the configured `day` doesn't exist in a given month,
 * it clamps to the last day of that month.
 */
function computeNextMonthlyFire(
  day: number,
  hour: number,
  minute: number,
  timezone: string,
  from: Date,
): string {
  const fromParts = getTzParts(from, timezone);
  let year = fromParts.year;
  let month = fromParts.month; // 1-indexed

  // 14 iterations is more than enough — at worst we advance a year.
  for (let i = 0; i < 14; i++) {
    const lastDay = daysInMonth(year, month);
    const fireDay = Math.min(day, lastDay);
    const candidate = buildUtcFromTz(year, month, fireDay, hour, minute, timezone);
    if (candidate.getTime() > from.getTime()) {
      return candidate.toISOString();
    }
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  throw new Error('computeNextMonthlyFire: failed to find next fire within 14 months');
}

function daysInMonth(year: number, month: number): number {
  // month is 1-indexed; day 0 of next month == last day of `month`.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

interface TzParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getTzParts(date: Date, timezone: string): TzParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const out: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    // Intl with hour12:false can emit "24" for midnight on some platforms.
    hour: out.hour === 24 ? 0 : out.hour,
    minute: out.minute,
    second: out.second,
  };
}

/**
 * Resolve a (year, month, day, hour, minute) tuple interpreted in `timezone`
 * to a UTC Date. Iterates to converge on the correct offset — this handles
 * DST transitions where the naive offset would be wrong by an hour.
 */
function buildUtcFromTz(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const targetMs = Date.UTC(year, month - 1, day, hour, minute, 0);
  let utc = targetMs;
  for (let i = 0; i < 3; i++) {
    const parts = getTzParts(new Date(utc), timezone);
    const localMs = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    const diff = targetMs - localMs;
    if (diff === 0) return new Date(utc);
    utc += diff;
  }
  return new Date(utc);
}
