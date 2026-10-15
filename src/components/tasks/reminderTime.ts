import { addDays, addHours, format, isThisYear, isToday, isTomorrow, nextMonday, setHours, startOfHour } from 'date-fns';

/** "Today 15:00", "Tomorrow 09:00", "Mon 20 Oct 09:00", "20 Oct 2027 09:00". */
export function formatReminder(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = format(date, 'HH:mm');
  if (isToday(date)) return `Today ${time}`;
  if (isTomorrow(date)) return `Tomorrow ${time}`;
  if (Math.abs(date.getTime() - now.getTime()) < 6 * 86_400_000) {
    return `${format(date, 'EEE d MMM')} ${time}`;
  }
  return isThisYear(date) ? `${format(date, 'd MMM')} ${time}` : `${format(date, 'd MMM yyyy')} ${time}`;
}

export interface ReminderPreset {
  label: string;
  at: Date;
}

/** Quick picks, Todoist-style. "Later today" drops out once the day is nearly over. */
export function reminderPresets(now: Date = new Date()): ReminderPreset[] {
  const atNine = (d: Date) => setHours(startOfHour(d), 9);
  const later = startOfHour(addHours(now, 4));
  const presets: ReminderPreset[] = [];
  if (isToday(later)) presets.push({ label: 'Later today', at: later });
  presets.push({ label: 'Tomorrow', at: atNine(addDays(now, 1)) });
  presets.push({ label: 'Next week', at: atNine(nextMonday(now)) });
  return presets;
}

/** `Date` → the `YYYY-MM-DDTHH:mm` a `datetime-local` input expects, in local time. */
export function toDateTimeLocal(date: Date): string {
  return format(date, "yyyy-MM-dd'T'HH:mm");
}
