/**
 * Plain-words labels for a routine's schedule ("Weekdays at 09:00"). Pure
 * and client-safe (no cron-parser), for the bot Routines tab and the routine
 * approval card.
 */
import type { ScheduleKind } from './schedule';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

function weekdaysLabel(days: number[]): string {
  const set = [...new Set(days)].filter((d) => d >= 0 && d <= 6).sort((a, b) => a - b);
  const key = set.join(',');
  if (set.length === 7) return 'Every day';
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';
  return `Every ${set.map((d) => DAY_NAMES[d]).join(', ')}`;
}

/**
 * The schedule in words, with the timezone when given: "Every day at 09:00
 * (Asia/Jakarta)", "Weekdays at 08:30", "Monthly on the 1st at 07:00",
 * "Cron 0 9 * * 1".
 */
export function describeSchedule(
  kind: ScheduleKind,
  spec: Record<string, unknown>,
  timezone?: string,
): string {
  const time = typeof spec.time === 'string' ? spec.time : '';
  let label: string;
  switch (kind) {
    case 'daily':
      label = `Every day at ${time}`;
      break;
    case 'weekly':
      label = `${weekdaysLabel(Array.isArray(spec.weekdays) ? (spec.weekdays as number[]) : [])} at ${time}`;
      break;
    case 'monthly':
      label = `Monthly on the ${ordinal(Number(spec.day) || 1)} at ${time}`;
      break;
    case 'cron':
      label = `Cron ${typeof spec.expression === 'string' ? spec.expression : ''}`.trim();
      break;
  }
  return timezone ? `${label} (${timezone})` : label;
}
