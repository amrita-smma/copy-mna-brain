import { createHash } from 'node:crypto';

/**
 * What a relationship overview was built from: the contact's notes (count and
 * newest email) and their active deal links, so linking or removing a deal
 * makes the overview — and its per-deal lines — stale too. With no deal links
 * it is `${noteCount}:${latestEmailId}`. Server-only (node:crypto).
 */
export function overviewInputHash(input: {
  noteCount: number;
  latestEmailId: string | null;
  dealCompanyIds: string[];
}): string {
  const base = `${input.noteCount}:${input.latestEmailId ?? ''}`;
  if (input.dealCompanyIds.length === 0) return base;
  const deals = [...input.dealCompanyIds].sort();
  const digest = createHash('sha1').update(deals.join(',')).digest('hex').slice(0, 12);
  return `${base}:${digest}`;
}
