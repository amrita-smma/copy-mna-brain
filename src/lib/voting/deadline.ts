/**
 * The voting deadline, as an absolute instant.
 *
 * The initiator picks a calendar day and a time of day in their own timezone;
 * the browser combines the two into a `Date` and sends its ISO string. The
 * server never re-derives the deadline from a duration — it stores exactly the
 * instant it was handed — so what the picker showed and what the cron sweeps on
 * can never drift apart.
 *
 * Every function here is pure and timezone-honest: the ones the form uses work
 * in the *viewer's* local zone (that is the zone the picker displays), and the
 * one the service uses works on absolute instants only.
 */

/**
 * How far out a deadline must be to be accepted.
 *
 * A round that expires within the minute would be swept before the invitation
 * email is even delivered, and 15 minutes is the smallest window in which a
 * voter could plausibly read the company card and cast a ballot.
 */
export const MIN_DEADLINE_LEAD_MS = 15 * 60 * 1000;

/** How far out a deadline may be — a year of "open" is a round nobody closes. */
export const MAX_DEADLINE_LEAD_MS = 365 * 24 * 60 * 60 * 1000;

/** `2026-09-28` */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** `17:30` */
const TIME_PATTERN = /^\d{2}:\d{2}$/;

export const isDeadlineDay = (value: unknown): value is string =>
  typeof value === 'string' && DAY_PATTERN.test(value);

export const isDeadlineTime = (value: unknown): value is string =>
  typeof value === 'string' && TIME_PATTERN.test(value);

/**
 * Validate the absolute deadline a client sent.
 *
 * Throws a plain `Error` whose message is user-facing — the service wraps it in
 * a `VoteRuleError` so the route answers 400 rather than 500.
 */
export function parseDeadline(value: unknown, now: Date): Date {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Pick a date and time for the voting deadline.');
  }
  const deadline = new Date(value.trim());
  if (Number.isNaN(deadline.getTime())) {
    throw new Error('The voting deadline is not a valid date and time.');
  }
  const lead = deadline.getTime() - now.getTime();
  if (lead < MIN_DEADLINE_LEAD_MS) {
    throw new Error('The voting deadline must be at least 15 minutes from now.');
  }
  if (lead > MAX_DEADLINE_LEAD_MS) {
    throw new Error('The voting deadline must be within a year from now.');
  }
  return deadline;
}

/**
 * Combine the picker's calendar day (`YYYY-MM-DD`) and time (`HH:mm`) into an
 * absolute instant **in the local timezone** — the zone the picker rendered
 * them in, so the initiator gets the wall-clock deadline they chose.
 *
 * Returns `null` for anything malformed or out of range (e.g. `25:00`), which
 * is what the form disables its confirm button on.
 */
export function combineDeadline(day: string, time: string): Date | null {
  if (!isDeadlineDay(day) || !isDeadlineTime(time)) return null;
  const [year, month, date] = day.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  if (month < 1 || month > 12 || date < 1 || date > 31) return null;
  if (hour > 23 || minute > 59) return null;
  const combined = new Date(year, month - 1, date, hour, minute, 0, 0);
  if (Number.isNaN(combined.getTime())) return null;
  // Rejects a day that does not exist (e.g. `2026-02-31`, which the Date
  // constructor silently rolls forward into March).
  if (combined.getFullYear() !== year || combined.getMonth() !== month - 1) return null;
  if (combined.getDate() !== date) return null;
  return combined;
}

/** A local `Date` back to the picker's `YYYY-MM-DD`. */
export function toDeadlineDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A local `Date` back to the picker's `HH:mm`. */
export function toDeadlineTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * What the picker opens on: two days out, snapped to the top of the hour so the
 * default reads as a deliberate deadline rather than a timestamp.
 */
export function defaultDeadline(now: Date): { day: string; time: string } {
  const target = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
  target.setMinutes(0, 0, 0);
  target.setHours(target.getHours() + 1);
  return { day: toDeadlineDay(target), time: toDeadlineTime(target) };
}

/**
 * How long is left, in words — `2 days 4 hours`, `35 minutes`, `past due`.
 *
 * Coarse by design: the picker only needs to reassure the initiator that the
 * window they chose is roughly the one they meant.
 */
export function describeTimeRemaining(deadline: Date, now: Date): string {
  const ms = deadline.getTime() - now.getTime();
  if (ms <= 0) return 'past due';

  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days} day${days === 1 ? '' : 's'}`);
  if (hours > 0) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`);
  // Minutes are noise next to a multi-day window, but they are the whole answer
  // for a same-afternoon one.
  if (days === 0 && minutes > 0) parts.push(`${minutes} minute${minutes === 1 ? '' : 's'}`);
  return parts.join(' ') || 'less than a minute';
}
