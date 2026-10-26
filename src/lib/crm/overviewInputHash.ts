import { createHash } from 'node:crypto';

/**
 * Bump when the overview job starts producing something new, so every stored
 * overview reads as stale and is regenerated (post-ingest, on open, or by
 * `/api/auth/crm-overviews/refresh` with an old `since`). v2: inferred
 * Industry / Area Focus.
 */
export const OVERVIEW_OUTPUT_VERSION = 'v2';

/**
 * What a relationship overview was built from: the output version, the
 * contact's notes (count and newest email) and their active deal links, so
 * linking or removing a deal makes the overview — and its per-deal lines —
 * stale too. With no deal links it is `${version}:${noteCount}:${latestEmailId}`.
 * Server-only (node:crypto).
 */
export function overviewInputHash(input: {
  noteCount: number;
  latestEmailId: string | null;
  dealCompanyIds: string[];
}): string {
  const base = `${OVERVIEW_OUTPUT_VERSION}:${input.noteCount}:${input.latestEmailId ?? ''}`;
  if (input.dealCompanyIds.length === 0) return base;
  const deals = [...input.dealCompanyIds].sort();
  const digest = createHash('sha1').update(deals.join(',')).digest('hex').slice(0, 12);
  return `${base}:${digest}`;
}
