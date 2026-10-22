/**
 * When a chat message was written, and how the transcript shows it: a small
 * time at the bottom right of every bubble, and a date between two messages
 * written on different days. Client safe: pure functions over the message's
 * `metadata.createdAt` (set by history pages, the live stream and the
 * composer; see `UIMessageMetadata`).
 */
import { differenceInCalendarDays, format, isSameDay, subDays } from 'date-fns';

export interface TimedMessage {
  metadata?: unknown;
}

/** A fresh `createdAt` stamp for a message the composer sends now. */
export function sentNow(now: Date = new Date()): { createdAt: string } {
  return { createdAt: now.toISOString() };
}

/** When the message was written, or null when it carries no usable stamp. */
export function messageCreatedAt(message: TimedMessage): Date | null {
  const raw = (message.metadata as { createdAt?: unknown } | undefined)?.createdAt;
  if (typeof raw !== 'string' || !raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The bubble's timestamp: the time of day, 24-hour ("09:41"). */
export function formatMessageTime(date: Date): string {
  return format(date, 'HH:mm');
}

/**
 * The date separator's label: Today, Yesterday, the weekday within the last
 * week, else the date ("Tue, 14 Oct", with the year once it differs).
 */
export function dayLabel(date: Date, now: Date = new Date()): string {
  if (isSameDay(date, now)) return 'Today';
  if (isSameDay(date, subDays(now, 1))) return 'Yesterday';
  const daysAgo = differenceInCalendarDays(now, date);
  if (daysAgo > 1 && daysAgo < 7) return format(date, 'EEEE');
  return date.getFullYear() === now.getFullYear() ? format(date, 'EEE, d MMM') : format(date, 'EEE, d MMM yyyy');
}

/**
 * Whether `next` is the first message of a new day after `previous` (the last
 * message before it with a known time; null at the top of the transcript, so
 * the first dated message always gets a separator).
 */
export function startsNewDay(previous: Date | null, next: Date): boolean {
  return previous === null || !isSameDay(previous, next);
}

/**
 * For each transcript row (a message, or a group of them) the date whose
 * separator goes above it, or null: the row's first known time when it falls
 * on another day than the last known time before it. Rows with no time at
 * all never break the day.
 */
export function dayStarts<T>(rows: readonly T[], timesOf: (row: T) => readonly (Date | null)[]): (Date | null)[] {
  let last: Date | null = null;
  return rows.map((row) => {
    const times = timesOf(row).filter((t): t is Date => t !== null);
    if (times.length === 0) return null;
    const first = times[0]!;
    const start = startsNewDay(last, first) ? first : null;
    last = times[times.length - 1]!;
    return start;
  });
}
