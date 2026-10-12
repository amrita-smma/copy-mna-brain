/**
 * The timeline composer lets a user stamp an entry with the moment it actually
 * happened rather than the moment they typed it, so a note written on Monday
 * about Friday's call lands on Friday. Every create path that accepts that
 * stamp (`deal_notes`, `deal_links`, `deal_documents`) normalises it here, so
 * one bad string is rejected the same way everywhere.
 */

/** A caller-supplied timeline date that is not a parseable timestamp. */
export class InvalidOccurredAtError extends Error {
  constructor(value: string) {
    super(`"${value}" is not a valid timeline date`);
    this.name = 'InvalidOccurredAtError';
  }
}

/**
 * Normalises a caller-supplied timeline date to an ISO string.
 *
 * Returns `undefined` when nothing was supplied, which leaves the column's
 * `defaultNow()` to stamp the row — that is the ordinary "happened just now"
 * case and must not be confused with a rejection.
 *
 * @throws {InvalidOccurredAtError} when a value was supplied but is unparseable.
 */
export function normalizeOccurredAt(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string') throw new InvalidOccurredAtError(String(value));

  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) throw new InvalidOccurredAtError(trimmed);

  return parsed.toISOString();
}
